import { z } from "zod";

import { assertNever } from "@app/types/shared/utils/assert_never";

/**
 * Continuous-score verification for completed MCP tool calls.
 *
 * Inspired by "LLM-as-a-Verifier: A General-Purpose Verification Framework"
 * (arxiv:2607.05391), which reframes verification as a scaling axis and argues
 * for a *continuous, calibrated* score over an agentic operation rather than a
 * single discrete LM-judge verdict (yes/no).
 *
 * Adaptation (Mode 3 — inspired experiment): the paper's headline mechanism
 * computes the verification score as the expectation over the distribution of
 * *scoring-token logits* in a single forward pass. Dust's LLM layer does not
 * expose token logprobs, so that exact mechanism cannot be ported here. We
 * instead obtain the continuous score from the paper's *other* two scaling
 * axes, which it shows independently improve verification and which do not
 * depend on logits:
 *   - score granularity: an ordered set of verdict grades (finer than yes/no),
 *     each weighted in [0, 1];
 *   - repeated evaluation: sampling N judge passes and aggregating, which the
 *     paper credits with variance reduction.
 *
 * The live LLM judge call is an injectable dependency (`JudgeVerdictFn`); the
 * production wiring in `runToolWithStreaming` gates it off by default until a
 * verifier model + feature flag are wired in. The grading, aggregation,
 * confidence, and ranking logic below is fully implemented and unit-tested.
 */

/**
 * Ordered verdict grades a judge can return for a tool call. Finer granularity
 * than a binary verdict is the paper's first scaling axis and improves
 * separation between correct and incorrect executions.
 */
export const ToolCallVerificationGradeSchema = z.enum([
  "correct",
  "mostly_correct",
  "partially_correct",
  "incorrect",
]);
export type ToolCallVerificationGrade = z.infer<
  typeof ToolCallVerificationGradeSchema
>;

/**
 * Rollout gate for the production wiring. Defaults to `false` so the forward
 * path is byte-for-byte unchanged until a verifier LLM + feature flag are in
 * place; flip to `true` once `JudgeVerdictFn` is provided at the call site.
 */
export const TOOL_CALL_VERIFICATION_ENABLED = false;

const GRADE_WEIGHTS: Record<ToolCallVerificationGrade, number> = {
  correct: 1,
  mostly_correct: 0.75,
  partially_correct: 0.4,
  incorrect: 0,
};

const GRADE_ORDER: ToolCallVerificationGrade[] = [
  "correct",
  "mostly_correct",
  "partially_correct",
  "incorrect",
];

/** Weight of a grade on the continuous [0, 1] verification scale. */
export function gradeWeight(grade: ToolCallVerificationGrade): number {
  switch (grade) {
    case "correct":
      return GRADE_WEIGHTS.correct;
    case "mostly_correct":
      return GRADE_WEIGHTS.mostly_correct;
    case "partially_correct":
      return GRADE_WEIGHTS.partially_correct;
    case "incorrect":
      return GRADE_WEIGHTS.incorrect;
    default:
      return assertNever(grade);
  }
}

/**
 * Parses a judge's raw textual verdict into a canonical grade. Accepts the
 * canonical token as well as human-friendly variants ("Mostly Correct",
 * "PARTIALLY-CORRECT"). Returns `null` when the verdict is absent or
 * unrecognized rather than guessing.
 */
export function parseGrade(
  raw: string | null | undefined
): ToolCallVerificationGrade | null {
  if (!raw) {
    return null;
  }
  const direct = ToolCallVerificationGradeSchema.safeParse(raw.trim());
  if (direct.success) {
    return direct.data;
  }
  // Normalize spaces / hyphens to the canonical underscore form.
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const variant = ToolCallVerificationGradeSchema.safeParse(normalized);
  if (variant.success) {
    return variant.data;
  }
  return null;
}

/** Plain, transport-free description of a completed tool call to verify. */
export interface ToolCallVerificationInput {
  toolName: string;
  toolDescription?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  userMessage?: unknown;
  agentName?: string;
}

/** Builds the prompt handed to the verifier judge. Pure. */
export function buildVerificationPrompt(
  input: ToolCallVerificationInput
): string {
  return [
    "You are verifying whether an MCP tool call executed correctly for an agentic task.",
    "Given the tool, its inputs, and the result it returned, decide how correct the",
    "execution is. Respond with exactly one grade on the first line, optionally",
    "followed by a one-line rationale.",
    "",
    "Grades (most to least correct):",
    "- correct",
    "- mostly_correct",
    "- partially_correct",
    "- incorrect",
    "",
    `Tool: ${input.toolName}`,
    ...(input.toolDescription
      ? [`Description: ${truncate(input.toolDescription, 500)}`]
      : []),
    ...(input.agentName ? [`Agent: ${input.agentName}`] : []),
    ...(input.userMessage != null
      ? [`Task: ${truncate(safeStringify(input.userMessage), 1000)}`]
      : []),
    ...(input.toolInput != null
      ? [`Inputs: ${truncate(safeStringify(input.toolInput), 2000)}`]
      : []),
    ...(input.toolResult != null
      ? [`Result: ${truncate(safeStringify(input.toolResult), 2000)}`]
      : []),
    "",
    "Grade:",
  ].join("\n");
}

/**
 * Continuous score for a set of graded verdicts, computed as the mean of the
 * grade weights plus their variance. The mean is the calibrated continuous
 * score (granularity scaling); the variance captures cross-sample disagreement
 * (repeated-evaluation scaling → confidence).
 */
export function expectationScore(grades: ToolCallVerificationGrade[]): {
  score: number;
  variance: number;
} {
  if (grades.length === 0) {
    return { score: 0, variance: 0 };
  }
  const weights = grades.map(gradeWeight);
  const mean = weights.reduce((sum, w) => sum + w, 0) / weights.length;
  if (weights.length === 1) {
    return { score: round3(mean), variance: 0 };
  }
  const variance =
    weights.reduce((acc, w) => acc + (w - mean) ** 2, 0) / weights.length;
  return { score: round3(mean), variance: round3(variance) };
}

/** Most frequent grade across samples, tie-broken toward the more-correct grade. */
export function modalGrade(
  grades: ToolCallVerificationGrade[]
): ToolCallVerificationGrade | null {
  if (grades.length === 0) {
    return null;
  }
  const counts = new Map<ToolCallVerificationGrade, number>();
  for (const grade of grades) {
    counts.set(grade, (counts.get(grade) ?? 0) + 1);
  }
  let best = grades[0];
  let bestCount = -1;
  // Canonical (most-correct first) order makes ties resolve toward "more correct".
  for (const grade of GRADE_ORDER) {
    const count = counts.get(grade) ?? 0;
    if (count > bestCount) {
      bestCount = count;
      best = grade;
    }
  }
  return best;
}

/**
 * Calibrated confidence in [0, 1]: the mean score penalized by cross-sample
 * disagreement. Low variance (consistent verdicts) preserves the score; high
 * variance (disagreement) erodes it. `variance` is bounded by ~0.25 for these
 * weights, so it is scaled by 4 into the penalty term.
 */
export function confidence(score: number, variance: number): number {
  const penalty = Math.min(variance * 4, 1);
  return round3(Math.max(0, score * (1 - penalty)));
}

/** A single judge pass: receives the verifier prompt, returns a raw verdict. */
export type JudgeVerdictFn = (prompt: string) => Promise<string | null>;

export interface ToolCallVerificationOptions {
  /**
   * Verifier judge. Injected so tests can stub it and production can wire a real
   * LLM call; when omitted, verification is unavailable and returns a null score
   * (see `verifyToolCall`).
   */
  judge?: JudgeVerdictFn;
  /** Number of independent judge passes (repeated-evaluation scaling). */
  samples?: number;
}

export interface ToolCallVerificationResult {
  /** Continuous [0, 1] score, or `null` when no judge was available. */
  score: number | null;
  variance: number | null;
  confidence: number | null;
  grade: ToolCallVerificationGrade | null;
  sampleCount: number;
}

/**
 * Verifies a completed tool call, returning a continuous score aggregated from
 * `samples` judge passes. With no `judge` provided this is a safe no-op that
 * returns a null score, so the call site can invoke it unconditionally.
 */
export async function verifyToolCall(
  input: ToolCallVerificationInput,
  options?: ToolCallVerificationOptions
): Promise<ToolCallVerificationResult> {
  const judge = options?.judge;
  if (!judge) {
    return {
      score: null,
      variance: null,
      confidence: null,
      grade: null,
      sampleCount: 0,
    };
  }
  const samples = Math.max(1, options?.samples ?? 1);
  const prompt = buildVerificationPrompt(input);
  const grades: ToolCallVerificationGrade[] = [];
  for (let i = 0; i < samples; i++) {
    const grade = parseGrade(await judge(prompt));
    if (grade) {
      grades.push(grade);
    }
  }
  if (grades.length === 0) {
    return {
      score: null,
      variance: null,
      confidence: null,
      grade: null,
      sampleCount: 0,
    };
  }
  const { score, variance } = expectationScore(grades);
  return {
    score,
    variance,
    confidence: confidence(score, variance),
    grade: modalGrade(grades),
    sampleCount: grades.length,
  };
}

export interface ScoredCandidate<T> {
  candidate: T;
  result: ToolCallVerificationResult;
}

/**
 * Cost-efficient ranking of candidate solutions by the verifier's continuous
 * scores (best-first). Null scores sort last. Returns a new array; the input is
 * not mutated.
 */
export function rankCandidates<T>(
  scored: ScoredCandidate<T>[]
): ScoredCandidate<T>[] {
  return [...scored].sort((a, b) => {
    const scoreA = a.result.score ?? -1;
    const scoreB = b.result.score ?? -1;
    return scoreB - scoreA;
  });
}

/**
 * Selects the best candidate whose score meets `threshold`, or `null` if none
 * qualifies — the paper's "select the best solution among candidates" use of
 * the continuous score.
 */
export function selectBestCandidate<T>(
  scored: ScoredCandidate<T>[],
  threshold = 0.5
): ScoredCandidate<T> | null {
  return (
    rankCandidates(scored).find((s) => (s.result.score ?? 0) >= threshold) ??
    null
  );
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}…`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    // Circular / non-serializable input (e.g. a Resource instance); fall back to
    // a best-effort string representation rather than failing verification.
    return String(value);
  }
}
