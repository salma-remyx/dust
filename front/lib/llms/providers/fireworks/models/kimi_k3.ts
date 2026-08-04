export function WithDustFireworksKimiK3Config<
  TBase extends abstract new (
    ...args: any[]
  ) => object,
>(Base: TBase) {
  abstract class DustFireworksKimiK3 extends Base {
    static readonly displayName = "Kimi K3 (Fireworks)";
    static readonly description =
      "Moonshot AI's Kimi K3, a 2.8T-parameter MoE model with a 1M-token context window and native vision (served via Fireworks).";
    static readonly defaultReasoningEffort = "low";
    static readonly byok = false;
  }

  return DustFireworksKimiK3;
}
