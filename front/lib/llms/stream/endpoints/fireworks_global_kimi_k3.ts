import { WithDustFireworksKimiK3Config } from "@app/lib/llms/providers/fireworks/models/kimi_k3";
import { defineDustStreamEndpoint } from "@app/lib/llms/stream/dust_stream_endpoint";
import { FireworksGlobalKimiK3Stream } from "@app/lib/model_constructors/stream/endpoints/fireworks_global_kimi_k3";

export class DustFireworksGlobalKimiK3Stream extends WithDustFireworksKimiK3Config(
  FireworksGlobalKimiK3Stream
) {
  static readonly endpointFilter = {};
}

defineDustStreamEndpoint(DustFireworksGlobalKimiK3Stream);
