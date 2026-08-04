import type { KnownModelLLMId } from "@dust-tt/client";
import { describe, expect, it } from "vitest";

import {
  FIREWORKS_KIMI_K3_MODEL_CONFIG,
  FIREWORKS_KIMI_K3_MODEL_ID,
} from "./fireworks";
import { STATIC_MODEL_IDS } from "./models";

// Compile-time guard: the Kimi K3 model id is part of the public SDK contract
// (KnownModelLLMId). This is enforced globally by sdk_drift.test.ts; restating
// it here means a focused typecheck failure points directly at this model.
const _k3IsKnownSdkModel: KnownModelLLMId = FIREWORKS_KIMI_K3_MODEL_ID;

describe("Kimi K3 (Fireworks) registration", () => {
  it("is declared in the Fireworks catalog with a 1M context window and vision", () => {
    expect(FIREWORKS_KIMI_K3_MODEL_CONFIG.modelId).toBe(
      FIREWORKS_KIMI_K3_MODEL_ID
    );
    expect(FIREWORKS_KIMI_K3_MODEL_CONFIG.providerId).toBe("fireworks");
    // Headline capabilities from the paper: 1M-token context + native vision.
    expect(FIREWORKS_KIMI_K3_MODEL_CONFIG.contextSize).toBe(1_000_000);
    expect(FIREWORKS_KIMI_K3_MODEL_CONFIG.supportsVision).toBe(true);
    expect(FIREWORKS_KIMI_K3_MODEL_CONFIG.largeModel).toBe(true);
    expect(FIREWORKS_KIMI_K3_MODEL_CONFIG.isLatest).toBe(true);
  });

  it("is part of the static model id set the UI and router discover models from", () => {
    expect(STATIC_MODEL_IDS).toContain(FIREWORKS_KIMI_K3_MODEL_ID);
    expect(_k3IsKnownSdkModel).toBe(FIREWORKS_KIMI_K3_MODEL_ID);
  });

  it("gates behind the shared Fireworks new-model feature flag (consistent with K2.5)", () => {
    expect(FIREWORKS_KIMI_K3_MODEL_CONFIG.availableIfOneOf?.featureFlag).toBe(
      "fireworks_new_model_feature"
    );
  });
});
