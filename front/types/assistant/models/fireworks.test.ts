import { isFireworksWhitelistedModelId } from "@app/lib/api/llm/clients/fireworks/types";
import { describe, expect, it } from "vitest";

import {
  FIREWORKS_KIMI_K3_MODEL_CONFIG,
  FIREWORKS_KIMI_K3_MODEL_ID,
} from "./fireworks";
import SUPPORTED_MODEL_CONFIGS from "./models";

// Kimi K3 (arxiv:2607.24653) ships a 1M-token context window and native
// vision. These are client-layer concerns: registering the served Fireworks
// endpoint is what exposes them to the platform. This test guards the wiring
// end-to-end — catalog registration (selectable), Fireworks-client whitelist
// (routed to FireworksLLM), and the headline capabilities reflected in config.
describe("Kimi K3 Fireworks endpoint", () => {
  it("is registered in the model catalog", () => {
    const config = SUPPORTED_MODEL_CONFIGS.find(
      (c) => c.modelId === FIREWORKS_KIMI_K3_MODEL_ID
    );
    expect(config).toBeDefined();
    expect(config).toEqual(FIREWORKS_KIMI_K3_MODEL_CONFIG);
  });

  it("exposes the paper's headline capabilities (1M context, vision)", () => {
    expect(FIREWORKS_KIMI_K3_MODEL_CONFIG.contextSize).toBe(1_000_000);
    expect(FIREWORKS_KIMI_K3_MODEL_CONFIG.supportsVision).toBe(true);
    expect(FIREWORKS_KIMI_K3_MODEL_CONFIG.isLatest).toBe(true);
  });

  it("is routed to the Fireworks client", () => {
    expect(isFireworksWhitelistedModelId(FIREWORKS_KIMI_K3_MODEL_ID)).toBe(
      true
    );
  });
});
