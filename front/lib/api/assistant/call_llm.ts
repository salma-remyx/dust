import { getStreamLLM } from "@app/lib/api/llm";
import type { FailoverCandidate } from "@app/lib/api/llm/failover_stream";
import { streamWithFailover } from "@app/lib/api/llm/failover_stream";
import type { LLMTraceContext } from "@app/lib/api/llm/traces/types";
import type { LLMStreamParameters } from "@app/lib/api/llm/types/options";
import { getLlmCredentials } from "@app/lib/api/provider_credentials";
import type { Authenticator } from "@app/lib/auth";
import type { ModelProviderIdType } from "@app/lib/resources/storage/models/workspace";
import type { ModelIdType } from "@app/types/assistant/models/types";
import type { LLMCredentialsType } from "@app/types/provider_credential";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { z } from "zod";

export interface LLMConfig {
  functionCall?: string | null;
  modelId: ModelIdType;
  providerId: ModelProviderIdType;
  temperature?: number;
  useCache?: boolean;
  useStream?: boolean;
  // Ordered fallback model ids. On an early retryable failure of `modelId`,
  // the conversation in `input` is forwarded verbatim to each fallback in turn
  // (History-Forwarding), preserving continuity across providers. Empty/absent
  // leaves behavior identical to a single-provider stream.
  fallbackModelIds?: ModelIdType[];
}

export interface LLMOptions {
  tracingRecords?: Record<string, string>;
  context?: LLMTraceContext;
  onRunId?: (runId: string) => Promise<void> | void;
}

// Zod schema to validate runActionStreamed output.
const _LLMOutputSchema = z.object({
  actions: z
    .array(
      z.object({
        name: z.string(),
        functionCallId: z.string().optional(),
        arguments: z.record(z.any()),
      })
    )
    .optional(),
  generation: z.string().nullable().optional(),
});

export type LLMOutput = z.infer<typeof _LLMOutputSchema>;

/**
 * Temporary wrapper around assistant-v2-multi-actions-agent Dust app to consolidate LLM interactions.
 * This provides a unified interface for calling LLMs while we transition away from individual Dust
 * apps. Once we have the direct LLM router ready, this wrapper will be fully removed.
 */
export async function runMultiActionsAgent(
  auth: Authenticator,
  config: LLMConfig,
  input: LLMStreamParameters,
  options: LLMOptions = {}
): Promise<Result<LLMOutput, Error>> {
  const credentials = await getLlmCredentials(auth, {
    skipEmbeddingApiKeyRequirement: true,
  });

  const llm = await getStreamLLM(auth, {
    credentials,
    modelId: config.modelId,
    temperature: config.temperature,
    context: options.context,
  });

  if (!llm) {
    // Should not happen
    return new Err(new Error(`Model ${config.modelId} not supported`));
  }

  await options.onRunId?.(llm.getTraceId());

  // History-Forwarding failover chain: primary first, then any configured
  // fallbacks. On an early retryable failure the conversation in `input` is
  // forwarded verbatim to the next provider, preserving continuity.
  const fallbacks = await buildFallbackLLMs(
    auth,
    credentials,
    config,
    options.context
  );
  const candidates: FailoverCandidate[] = [llm, ...fallbacks];

  const actions: NonNullable<LLMOutput["actions"]> = [];
  let generation = "";

  for await (const event of streamWithFailover(candidates, input)) {
    if (event.type === "error") {
      return new Err(new Error(`LLM error: ${event.content.message}`));
    }

    if (event.type === "text_generated") {
      generation += event.content.text;
    }

    if (event.type === "tool_call") {
      actions.push({
        name: event.content.name,
        functionCallId: event.content.id,
        arguments: event.content.arguments,
      });
    }
  }

  return new Ok({ actions, generation });
}

// Resolves the configured fallback LLMs. Kept sequential (rather than
// `Promise.all`) because each `getStreamLLM` call may touch the auth/feature-
// flag layer, and the fallback chain is expected to stay small (1–2 entries).
async function buildFallbackLLMs(
  auth: Authenticator,
  credentials: LLMCredentialsType,
  config: LLMConfig,
  context?: LLMTraceContext
): Promise<FailoverCandidate[]> {
  const fallbacks: FailoverCandidate[] = [];
  for (const modelId of config.fallbackModelIds ?? []) {
    const fallback = await getStreamLLM(auth, {
      credentials,
      modelId,
      temperature: config.temperature,
      context,
    });
    if (fallback) {
      fallbacks.push(fallback);
    }
  }
  return fallbacks;
}
