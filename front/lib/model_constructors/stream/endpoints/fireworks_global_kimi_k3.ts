import { WithFireworksKimiK3Config } from "@app/lib/model_constructors/providers/fireworks/models/kimi_k3";
import { FireworksStream } from "@app/lib/model_constructors/stream/clients/fireworks";
import type { StreamEndpointConstructor } from "@app/lib/model_constructors/stream/configuration";
import { GLOBAL } from "@app/lib/model_constructors/types/regions";

export class FireworksGlobalKimiK3Stream extends WithFireworksKimiK3Config(
  FireworksStream
) {
  // https://fireworks.ai/models/fireworks/kimi-k3
  static readonly tokenPricing = {
    cacheHit: 0.1,
    standardInput: 0.6,
    standardOutput: 3.0,
  };
  static readonly region = GLOBAL;
  static readonly id = this.buildId();
}
FireworksGlobalKimiK3Stream satisfies StreamEndpointConstructor;
