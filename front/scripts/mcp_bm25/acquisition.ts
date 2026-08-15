// Cost-aware stopping analysis for MCP tool acquisition.
//
// A tool-search ranker (BM25 or otherwise) returns a ranking, but a ranking
// alone does not decide how many tools to acquire: acquiring too few leaves
// the task under-informed, while too many adds cost, context load, and privacy
// exposure. This module turns the labeled ranks produced by the BM25 harness
// into an acquisition decision, using cost-aware marginal decision-focused
// stopping (CAM-DF-lite): at each ranked prefix, the decision to acquire one
// more tool is labeled by the sign of the offline gap between stopping now and
// the best continuation, and weighted by the payoff at stake.
//
// Adapted from "Scores Are Not Decisions: Cost-Aware Stopping for Tool
// Acquisition in LLM Agents" (arXiv:2607.27083). The paper trains a payoff
// estimator per task; here the labeled query set of this harness is the payoff
// signal (parameter-free) and per-tool costs are simulated, which is enough to
// compare stopping against the fixed top-N acquisition the live tool search
// performs today.

export interface AcquisitionCosts {
  // Value of surfacing the tool a task actually needs, in cost units.
  hitValue: number;
  // Cost of acquiring the tool at 1-based `rank`, in cost units. Heterogeneous
  // by rank (e.g. escalating for weaker hits) is what makes score-only
  // thresholds suboptimal in the paper.
  toolCost: (rank: number) => number;
}

export const DEFAULT_ACQUISITION_COSTS: AcquisitionCosts = {
  hitValue: 1,
  toolCost: () => 0.1,
};

export interface AcquisitionPoint {
  // Prefix size k: acquire the top k ranked tools.
  count: number;
  // Fraction of labeled queries whose expected tool is within the top k.
  recall: number;
  // Simulated acquisition cost per query (sum of toolCost over the prefix).
  costPerQuery: number;
  // Expected payoff per query: hitValue * recall - costPerQuery.
  payoff: number;
  // payoff(k) - payoff(k-1); the marginal value of the k-th tool.
  marginalGain: number;
  // Offline gap between stopping at k and the best continuation past k.
  gapToBestContinuation: number;
  // Decision-focused label: true when that gap favors acquiring one more.
  continues: boolean;
}

// Builds the per-prefix acquisition table from the 1-based rank of the
// expected tool for each labeled query (0 when the expected tool is not
// retrieved at all).
export function acquisitionCurve({
  ranks,
  costs = DEFAULT_ACQUISITION_COSTS,
  maxCount,
}: {
  ranks: number[];
  costs?: AcquisitionCosts;
  maxCount: number;
}): AcquisitionPoint[] {
  if (ranks.length === 0 || maxCount < 1) {
    return [];
  }

  const n = ranks.length;
  const prefixCost = [0];
  for (let k = 1; k <= maxCount; k++) {
    prefixCost.push(prefixCost[k - 1] + costs.toolCost(k));
  }

  const payoffs = [];
  for (let k = 1; k <= maxCount; k++) {
    const hits = ranks.filter((r) => r >= 1 && r <= k).length;
    payoffs.push((costs.hitValue * hits) / n - prefixCost[k]);
  }

  // Best payoff reachable from each prefix onwards, so the stop/continue label
  // at point i is the sign of max_{j>i} payoff(j) - payoff(i).
  const bestFrom = new Array<number>(maxCount).fill(-Infinity);
  for (let i = maxCount - 2; i >= 0; i--) {
    bestFrom[i] = Math.max(payoffs[i + 1], bestFrom[i + 1]);
  }

  const points: AcquisitionPoint[] = [];
  for (let k = 1; k <= maxCount; k++) {
    const payoff = payoffs[k - 1];
    const gap = k === maxCount ? 0 : bestFrom[k - 1] - payoff;
    points.push({
      count: k,
      recall: ranks.filter((r) => r >= 1 && r <= k).length / n,
      costPerQuery: prefixCost[k],
      payoff,
      marginalGain: k >= 2 ? payoff - payoffs[k - 2] : payoff,
      gapToBestContinuation: gap,
      // Ties stop: an equal payoff further out is not worth more tools.
      continues: gap > 0,
    });
  }
  return points;
}

export interface AcquisitionDecision {
  // Prefix size the decision-focused rule stops at.
  count: number;
  // Payoff per query at that stop.
  payoff: number;
  // Prefix size with the highest payoff (the predict-then-acquire baseline).
  bestCount: number;
  bestPayoff: number;
  // bestPayoff - payoff: what the greedy prefix decision gives up.
  regret: number;
}

// Applies the CAM-DF-lite stopping labels: stop at the first prefix whose gap
// to the best continuation is not positive, and report what that gives up
// against the prefix with the highest payoff.
export function decideAcquisitionCount(
  curve: AcquisitionPoint[]
): AcquisitionDecision {
  if (curve.length === 0) {
    return {
      count: 0,
      payoff: 0,
      bestCount: 0,
      bestPayoff: 0,
      regret: 0,
    };
  }

  let bestIdx = 0;
  for (let i = 1; i < curve.length; i++) {
    if (curve[i].payoff > curve[bestIdx].payoff) {
      bestIdx = i;
    }
  }

  const stopIdx = curve.findIndex((p) => !p.continues);
  const stop = stopIdx === -1 ? curve[curve.length - 1] : curve[stopIdx];

  return {
    count: stop.count,
    payoff: stop.payoff,
    bestCount: curve[bestIdx].count,
    bestPayoff: curve[bestIdx].payoff,
    regret: curve[bestIdx].payoff - stop.payoff,
  };
}

// Live counterpart of the offline curve, for when no labels are available: the
// per-query rule an agent harness could apply to a raw ranking. The paper
// learns the marginal payoff of the next tool; the score decay against the top
// hit is the parameter-free proxy for it, and `costFraction` is the per-tool
// acquisition cost expressed as a fraction of the top hit's value.
export function decideCountFromScores({
  scores,
  costFraction = 0.2,
}: {
  scores: number[];
  costFraction?: number;
}): number {
  const top = scores[0];
  if (top === undefined || top <= 0) {
    return 0;
  }
  let count = 0;
  for (const score of scores) {
    if (score / top < costFraction) {
      break;
    }
    count++;
  }
  return count;
}
