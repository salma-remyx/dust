import type {
  FailoverCandidate,
  FailoverInfo,
} from "@app/lib/api/llm/failover_stream";
import { streamWithFailover } from "@app/lib/api/llm/failover_stream";
import type { LLMEvent } from "@app/lib/api/llm/types/events";
import { EventError } from "@app/lib/api/llm/types/events";
import type {
  LLMClientMetadata,
  LLMStreamParameters,
} from "@app/lib/api/llm/types/options";
import { describe, expect, it, vi } from "vitest";

// `EventError` and the event/option types are imported from the existing
// (non-new) LLM type modules so this exercises the real event contract rather
// than a hand-rolled stand-in.

const META_PRIMARY: LLMClientMetadata = {
  clientId: "openai",
  inferenceProvider: "openai",
  inferenceRegion: "global",
  modelId: "noop",
};

const META_FALLBACK: LLMClientMetadata = {
  clientId: "fireworks",
  inferenceProvider: "fireworks",
  inferenceRegion: "global",
  modelId: "noop",
};

const INPUT: LLMStreamParameters = {
  conversation: { messages: [] },
  prompt: "continue the conversation",
  specifications: [],
};

function retryableError(
  meta: LLMClientMetadata,
  message = "rate limited"
): EventError {
  return new EventError(
    {
      type: "rate_limit_error",
      message,
      isRetryable: true,
    },
    meta
  );
}

function nonRetryableError(meta: LLMClientMetadata): EventError {
  return new EventError(
    {
      type: "authentication_error",
      message: "invalid api key",
      isRetryable: false,
    },
    meta
  );
}

function successEvent(meta: LLMClientMetadata): LLMEvent {
  return {
    type: "success",
    aggregated: [],
    metadata: meta,
  };
}

function textEvent(meta: LLMClientMetadata, text: string): LLMEvent {
  return {
    type: "text_generated",
    content: { text },
    metadata: meta,
  };
}

// A lightweight FailoverCandidate that replays a scripted event list and
// records the streamParameters it received (to assert History-Forwarding).
function makeCandidate(
  events: LLMEvent[],
  meta: LLMClientMetadata
): {
  candidate: FailoverCandidate;
  received: () => LLMStreamParameters | undefined;
} {
  let receivedParams: LLMStreamParameters | undefined;
  const candidate: FailoverCandidate = {
    getMetadata: () => meta,
    async *stream(params: LLMStreamParameters): AsyncGenerator<LLMEvent> {
      receivedParams = params;
      for (const event of events) {
        yield event;
      }
    },
  };
  return { candidate, received: () => receivedParams };
}

async function collect(stream: AsyncGenerator<LLMEvent>): Promise<LLMEvent[]> {
  const out: LLMEvent[] = [];
  for await (const event of stream) {
    out.push(event);
  }
  return out;
}

describe("streamWithFailover", () => {
  it("streams the primary when it succeeds and never fails over", async () => {
    const primary = makeCandidate(
      [textEvent(META_PRIMARY, "hi"), successEvent(META_PRIMARY)],
      META_PRIMARY
    );
    const onFailover = vi.fn();

    const events = await collect(
      streamWithFailover([primary.candidate], INPUT, undefined, { onFailover })
    );

    expect(events.map((e) => e.type)).toEqual(["text_generated", "success"]);
    expect(onFailover).not.toHaveBeenCalled();
  });

  it("forwards the conversation to a fallback on an early retryable error", async () => {
    const primary = makeCandidate([retryableError(META_PRIMARY)], META_PRIMARY);
    const fallback = makeCandidate(
      [textEvent(META_FALLBACK, "recovered"), successEvent(META_FALLBACK)],
      META_FALLBACK
    );
    const onFailover = vi.fn();

    const events = await collect(
      streamWithFailover(
        [primary.candidate, fallback.candidate],
        INPUT,
        undefined,
        { onFailover }
      )
    );

    expect(events.map((e) => e.type)).toEqual(["text_generated", "success"]);
    // History-Forwarding: the fallback received the exact same streamParameters
    // (and therefore the same conversation) as the primary — CPR preserved.
    expect(fallback.received()).toBe(INPUT);
    expect(onFailover).toHaveBeenCalledTimes(1);

    const info: FailoverInfo = onFailover.mock.calls[0][0];
    expect(info.fromIndex).toBe(0);
    expect(info.toIndex).toBe(1);
    expect(info.conversationForwarded).toBe(true);
    expect(info.error.isRetryable).toBe(true);
  });

  it("does not fail over on a non-retryable error", async () => {
    const primary = makeCandidate(
      [nonRetryableError(META_PRIMARY)],
      META_PRIMARY
    );
    const fallback = makeCandidate(
      [successEvent(META_FALLBACK)],
      META_FALLBACK
    );
    const onFailover = vi.fn();

    const events = await collect(
      streamWithFailover(
        [primary.candidate, fallback.candidate],
        INPUT,
        undefined,
        { onFailover }
      )
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    expect(fallback.received()).toBeUndefined();
    expect(onFailover).not.toHaveBeenCalled();
  });

  it("does not fail over once output has already been committed", async () => {
    const primary = makeCandidate(
      [textEvent(META_PRIMARY, "partial"), retryableError(META_PRIMARY)],
      META_PRIMARY
    );
    const fallback = makeCandidate(
      [successEvent(META_FALLBACK)],
      META_FALLBACK
    );
    const onFailover = vi.fn();

    const events = await collect(
      streamWithFailover(
        [primary.candidate, fallback.candidate],
        INPUT,
        undefined,
        { onFailover }
      )
    );

    // Committed text + the terminal error are surfaced; no failover.
    expect(events.map((e) => e.type)).toEqual(["text_generated", "error"]);
    expect(onFailover).not.toHaveBeenCalled();
  });

  it("surfaces the last candidate's error when every candidate fails", async () => {
    const primary = makeCandidate([retryableError(META_PRIMARY)], META_PRIMARY);
    const fallback = makeCandidate(
      [retryableError(META_FALLBACK)],
      META_FALLBACK
    );
    const onFailover = vi.fn();

    const events = await collect(
      streamWithFailover(
        [primary.candidate, fallback.candidate],
        INPUT,
        undefined,
        { onFailover }
      )
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    expect(onFailover).toHaveBeenCalledTimes(1);
  });

  it("does not fail over when there is only one candidate", async () => {
    const primary = makeCandidate([retryableError(META_PRIMARY)], META_PRIMARY);
    const onFailover = vi.fn();

    const events = await collect(
      streamWithFailover([primary.candidate], INPUT, undefined, { onFailover })
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    expect(onFailover).not.toHaveBeenCalled();
  });
});
