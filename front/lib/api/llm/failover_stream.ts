import type { LLMErrorInfo } from "@app/lib/api/llm/types/errors";
import type { EventError, LLMEvent } from "@app/lib/api/llm/types/events";
import type {
  LLMClientMetadata,
  LLMStreamMetadata,
  LLMStreamParameters,
} from "@app/lib/api/llm/types/options";
import logger from "@app/logger/logger";

/**
 * History-Forwarding stateful failover for the LLM stream path.
 *
 * When a primary provider fails with a retryable error BEFORE committing any
 * output to the caller, the stream transparently re-runs against the next
 * fallback candidate while forwarding the full conversation history
 * (`streamParameters.conversation`) verbatim. Because the fallback receives the
 * exact same conversation the primary did, conversational continuity is
 * preserved (Continuity Preservation Rate ≈ 1.0) instead of being silently
 * dropped by a naive stateless failover (CPR ≈ 0).
 *
 * Adapted (Mode 2) from "ContinuityBench: A Benchmark and Systems Study of
 * Stateful Failover in Multi-Provider LLM Routing" (arXiv:2607.15899): the
 * History-Forwarding failover mechanism is implemented at full fidelity. The
 * paper's standalone HTTP proxy, its high-concurrency benchmark harness, and
 * the Continuity Latency Overhead (CLO) latency-distribution characterization
 * are intentionally out of scope here — they belong in a downstream evaluation
 * PR. The paper's "asynchronous exponential backoff with jitter" retry policy
 * is likewise left to the existing retry layer that wraps this stream.
 */

// Minimal structural view of an LLM sufficient to drive failover. The concrete
// `LLM` base class satisfies this; tests may pass lightweight doubles.
export interface FailoverCandidate {
  getMetadata(): LLMClientMetadata;
  stream(
    streamParameters: LLMStreamParameters,
    metadata?: LLMStreamMetadata
  ): AsyncGenerator<LLMEvent>;
}

export interface FailoverInfo {
  // Index (within `candidates`) of the provider that failed.
  fromIndex: number;
  // Index of the provider being failed over to.
  toIndex: number;
  // The retryable terminal error that triggered the failover.
  error: LLMErrorInfo;
  // Always `true`: the full conversation is forwarded to the fallback verbatim.
  // Surfaced so callers/metrics can record Continuity Preservation Rate.
  conversationForwarded: true;
}

interface FailoverStreamOptions {
  // Notified each time the stream fails over from one candidate to the next.
  onFailover?: (info: FailoverInfo) => void;
}

// Events that are safe to fail over AFTER: pure pre-content metadata that
// commits no output to the caller. Once anything outside this set is yielded
// (any delta, generated text/reasoning, a tool call, or success) the stream is
// committed and failover is no longer safe — re-running against a fallback
// would duplicate or corrupt the partial response.
const PRE_CONTENT_EVENT_TYPES: ReadonlySet<LLMEvent["type"]> = new Set([
  "interaction_id",
  "provider_passthrough",
  "token_usage",
  "tool_call_started",
]);

/**
 * Streams from `candidates[0]` (the primary). On an EARLY retryable error — one
 * that arrives before any committed output — fails over to the next candidate,
 * forwarding the same `streamParameters` (which carries the full `conversation`)
 * unchanged. With a single candidate this is equivalent to streaming the
 * primary directly.
 *
 * `candidates` must be non-empty; the first element is the primary, the rest are
 * ordered fallbacks.
 */
export async function* streamWithFailover(
  candidates: FailoverCandidate[],
  streamParameters: LLMStreamParameters,
  metadata?: LLMStreamMetadata,
  options?: FailoverStreamOptions
): AsyncGenerator<LLMEvent> {
  if (candidates.length === 0) {
    throw new Error("streamWithFailover requires at least one candidate LLM");
  }

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    let outputCommitted = false;
    let terminalError: EventError | null = null;

    for await (const event of candidate.stream(streamParameters, metadata)) {
      // Defer the terminal error: decide below whether to fail over or surface it.
      if (event.type === "error") {
        terminalError = event;
        break;
      }
      if (!PRE_CONTENT_EVENT_TYPES.has(event.type)) {
        outputCommitted = true;
      }
      yield event;
    }

    // The candidate completed without a terminal error (success, or a clean end
    // that the base stream already turns into a non-error terminal event).
    if (terminalError === null) {
      return;
    }

    // Fail over only on an early retryable error: nothing committed yet, the
    // error is retryable, and a fallback remains. The same `streamParameters` —
    // and therefore its `conversation` — is forwarded verbatim to the next
    // candidate (the History-Forwarding invariant).
    const next = candidates[index + 1];
    if (
      outputCommitted ||
      !terminalError.content.isRetryable ||
      next === undefined
    ) {
      yield terminalError;
      return;
    }

    const fromMetadata = candidate.getMetadata();
    const toMetadata = next.getMetadata();
    const info: FailoverInfo = {
      fromIndex: index,
      toIndex: index + 1,
      error: terminalError.content,
      conversationForwarded: true,
    };
    logger.warn(
      {
        fromProvider: fromMetadata.clientId,
        fromModelId: fromMetadata.modelId,
        toProvider: toMetadata.clientId,
        toModelId: toMetadata.modelId,
        errorType: terminalError.content.type,
      },
      "LLM stream failover: forwarding conversation to fallback provider"
    );
    options?.onFailover?.(info);
    // Loop advances to `next`, forwarding `streamParameters` unchanged.
  }
}
