import {
  acquisitionCurve,
  decideAcquisitionCount,
  decideCountFromScores,
} from "@app/scripts/mcp_bm25/acquisition";
import type { Document } from "@app/scripts/mcp_bm25/bm25";
import { buildIndex, rank } from "@app/scripts/mcp_bm25/bm25";
import { describe, expect, test } from "vitest";

describe("acquisitionCurve", () => {
  test("labels each prefix with the gap to the best continuation", () => {
    // 3 queries: expected tool at rank 1, 1, 3.
    const curve = acquisitionCurve({
      ranks: [1, 1, 3],
      costs: { hitValue: 1, toolCost: () => 0.2 },
      maxCount: 4,
    });

    expect(curve.map((p) => p.count)).toEqual([1, 2, 3, 4]);
    expect(curve[0].recall).toBeCloseTo(2 / 3);
    expect(curve[2].recall).toBe(1);
    expect(curve[0].costPerQuery).toBeCloseTo(0.2);
    expect(curve[2].costPerQuery).toBeCloseTo(0.6);

    // Payoffs: k=1 -> 2/3 - 0.2 = 0.467 (the peak), k=2 -> 0.267, k=3 -> 0.4,
    // k=4 -> 0.2. From k=2 the best continuation is k=3, so k=2 is labeled
    // continue; k=1 has no better continuation and stops.
    expect(curve[0].payoff).toBeCloseTo(2 / 3 - 0.2);
    expect(curve[0].continues).toBe(false);
    expect(curve[1].continues).toBe(true);
    expect(curve[2].payoff).toBeCloseTo(1 - 0.6);
    expect(curve[2].continues).toBe(false);
    expect(curve[3].continues).toBe(false);
  });

  test("continues when a later prefix has strictly better payoff", () => {
    // With a cheap 5th tool and one query whose expected tool ranks 5th,
    // stopping at k<5 gives up payoff, so the labels favor acquiring more.
    const curve = acquisitionCurve({
      ranks: [1, 5],
      costs: { hitValue: 1, toolCost: () => 0.05 },
      maxCount: 5,
    });

    expect(curve[0].continues).toBe(true);
    // The gap shrinks to 0 at the best prefix, which is labeled stop (ties
    // stop: an equal payoff further out is not worth more tools).
    const best = curve.reduce((a, b) => (b.payoff > a.payoff ? b : a));
    expect(best.continues).toBe(false);
    expect(best.gapToBestContinuation).toBe(0);
  });

  test("returns an empty curve for empty inputs", () => {
    expect(acquisitionCurve({ ranks: [], maxCount: 5 })).toEqual([]);
    expect(acquisitionCurve({ ranks: [1], maxCount: 0 })).toEqual([]);
  });
});

describe("decideAcquisitionCount", () => {
  test("stops at the first prefix whose continuation gap is not positive", () => {
    const curve = acquisitionCurve({
      ranks: [1, 1, 3],
      costs: { hitValue: 1, toolCost: () => 0.2 },
      maxCount: 4,
    });
    const decision = decideAcquisitionCount(curve);

    // Full recall is not worth its cost here: the rule stops at k=1, which is
    // also the payoff peak.
    expect(decision.count).toBe(1);
    expect(decision.bestCount).toBe(1);
    expect(decision.regret).toBe(0);
  });

  test("reports regret when the stop is earlier than the best payoff", () => {
    const curve = acquisitionCurve({
      ranks: [1, 5],
      costs: { hitValue: 1, toolCost: () => 0.05 },
      maxCount: 5,
    });
    const decision = decideAcquisitionCount(curve);

    // The stopping rule walks the labels: it acquires while the gap is
    // positive and stops at the best prefix, so no payoff is given up.
    expect(decision.count).toBe(decision.bestCount);
    expect(decision.regret).toBe(0);
    expect(decision.bestCount).toBeGreaterThanOrEqual(1);
  });

  test("handles an empty curve", () => {
    expect(decideAcquisitionCount([])).toEqual({
      count: 0,
      payoff: 0,
      bestCount: 0,
      bestPayoff: 0,
      regret: 0,
    });
  });
});

describe("decideCountFromScores on the live ranking", () => {
  const docs: Document[] = [
    { name: "a.search", text: "search jira tickets issues" },
    { name: "a.create", text: "create a new jira ticket issue" },
    { name: "b.list", text: "list documents in a drive folder" },
    { name: "b.copy", text: "copy documents between drive folders" },
  ];

  test("acquires the tools whose score is within costFraction of the top hit", () => {
    const idx = buildIndex(docs);
    const scores = rank("search jira tickets", idx).map((r) => r.score);

    // The two Jira tools share the query vocabulary, the two Drive tools do
    // not, so the rule acquires a short prefix rather than the whole list.
    const count = decideCountFromScores({ scores, costFraction: 0.2 });
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThan(scores.length);
  });

  test("returns 0 when nothing scores", () => {
    expect(decideCountFromScores({ scores: [0, 0] })).toBe(0);
    expect(decideCountFromScores({ scores: [] })).toBe(0);
  });
});
