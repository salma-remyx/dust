import type {
  AgentAuditMetrics,
  ToolCall,
} from "@app/tests/sidekick-evals/lib/types";

/** Inputs for computeAgentAuditMetrics. */
export interface AuditMetricsInput {
  toolCalls: ToolCall[];
  responseText: string;
  expectedToolCalls?: string[];
  judgeCriteria: string;
  /** Sidekick tool-call latency; feeds the elapsed_time bands and Q_h. */
  modelTimeMs?: number;
  /** Tool names in the sidekick's spec; enables tool_hallucination. */
  availableToolNames?: string[];
  /** Judge score on the 0-3 scale; feeds the Q_h trade-off. */
  effectivenessScore?: number;
}

/**
 * Multidimensional agent-audit metrics for the sidekick evals, adapted from
 * A^2E (Agent Auditing Engine, arxiv:2608.07346) — tool use, execution
 * efficiency, task planning, and error recovery instead of a single score.
 *
 * Mode 2 (adapted port): the core mechanism (multidimensional trace-derived
 * audit scores) is kept at full fidelity; A^2E's Monitor instrumentation and
 * learned per-dimension estimators are replaced by parameter-free deterministic
 * proxies over the trajectory the evals already capture. The Agent Task
 * Protocol and harness-integration framework are out of scope — the evals own
 * that.
 */

// Dimension weights for the overall aggregate. Tool use and task planning
// dominate for an agent-builder sidekick; raw efficiency matters least.
const WEIGHT_TOOL_USE = 0.35;
const WEIGHT_PLANNING = 0.3;
const WEIGHT_RECOVERY = 0.2;
const WEIGHT_EFFICIENCY = 0.15;

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "if",
  "then",
  "else",
  "when",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "is",
  "are",
  "be",
  "should",
  "must",
  "not",
  "no",
  "score",
  "tool",
  "call",
  "agent",
  "sidekick",
  "user",
  "this",
  "that",
  "it",
  "as",
  "at",
  "by",
  "from",
  "into",
  "they",
  "their",
  "you",
  "your",
]);

// toolEconomy indexed by tool-call count: [0]=no calls, [1]=one call, ...
// Mirrors MAX_TOOL_CALL_ROUNDS (5) — more rounds is less efficient.
const TOOL_ECONOMY_BY_COUNT: ReadonlyArray<number> = [
  1, 1, 0.9, 0.75, 0.6, 0.4,
];

function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Stable signature so repeated calls with the same args count as redundant. */
function signatureOf(toolCall: { name: string; arguments: unknown }): string {
  return `${toolCall.name}::${JSON.stringify(toolCall.arguments)}`;
}

function extractKeywords(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 3 && !STOPWORDS.has(token));
  return Array.from(new Set(tokens));
}

// Elapsed-time bands from the A^2E metrics catalog: fast < 5s, medium
// 5-30s, slow >= 30s. The slow-band boundary also normalizes time for Q_h.
const ELAPSED_FAST_MAX_MS = 5_000;
const ELAPSED_SLOW_MIN_MS = 30_000;

function computeToolUse(
  input: AuditMetricsInput
): AgentAuditMetrics["toolUse"] {
  const expected = input.expectedToolCalls ?? [];
  const actualNames = input.toolCalls.map((toolCall) => toolCall.name);
  const missingExpectedCount = expected.filter(
    (name) => !actualNames.includes(name)
  ).length;
  const recall =
    expected.length === 0
      ? 1
      : (expected.length - missingExpectedCount) / expected.length;

  const signatures = input.toolCalls.map(signatureOf);
  const totalCalls = input.toolCalls.length;
  const uniqueCalls = new Set(signatures).size;
  const redundantCalls = totalCalls - uniqueCalls;
  const precision = totalCalls === 0 ? 1 : uniqueCalls / totalCalls;

  const score = clamp01(0.6 * recall + 0.4 * precision);
  return {
    recall: round(recall),
    precision: round(precision),
    score: round(score),
    totalCalls,
    redundantCalls,
    missingExpectedCount,
  };
}

function computeExecutionEfficiency(
  input: AuditMetricsInput
): AgentAuditMetrics["executionEfficiency"] {
  const responseWordCount = input.responseText
    .split(/\s+/)
    .filter((word) => word.length > 0).length;

  // Penalize both near-empty and overly verbose responses. Between 5 and 200
  // words is considered appropriately concise; verbosity decays past 200.
  let responseVerbosity: number;
  if (responseWordCount < 5) {
    responseVerbosity = 0.3;
  } else if (responseWordCount <= 200) {
    responseVerbosity = 1;
  } else {
    // Linear decay from 1.0 at 200 words to 0.3 at 800 words.
    responseVerbosity = clamp01(1 - ((responseWordCount - 200) / 600) * 0.7);
  }

  const toolCallCount = input.toolCalls.length;
  const toolEconomy =
    toolCallCount < TOOL_ECONOMY_BY_COUNT.length
      ? (TOOL_ECONOMY_BY_COUNT[toolCallCount] ?? 0.4)
      : 0.4;

  const score = clamp01(0.6 * responseVerbosity + 0.4 * toolEconomy);
  return {
    responseVerbosity: round(responseVerbosity),
    toolEconomy: round(toolEconomy),
    score: round(score),
    responseWordCount,
  };
}

function computeTaskPlanning(
  input: AuditMetricsInput
): AgentAuditMetrics["taskPlanning"] {
  // Structured step indicators: numbered lists ("1." / "2)") or bullet items.
  const matches = input.responseText.match(/(?:^|\n)\s*(?:\d+[.)]|[-*])\s+\S/g);
  const structuredStepCount = matches ? matches.length : 0;
  let structureScore: number;
  if (structuredStepCount === 0) {
    structureScore = 0.4;
  } else if (structuredStepCount < 3) {
    structureScore = 0.7;
  } else {
    structureScore = 1;
  }

  const keywords = extractKeywords(input.judgeCriteria);
  const lowerResponse = input.responseText.toLowerCase();
  const matched = keywords.filter((keyword) => lowerResponse.includes(keyword));
  // Neutral when there are no criteria keywords to match against.
  const criteriaCoverage =
    keywords.length === 0 ? 0.5 : matched.length / keywords.length;

  const score = clamp01(0.5 * structureScore + 0.5 * criteriaCoverage);
  return {
    structureScore: round(structureScore),
    criteriaCoverage: round(criteriaCoverage),
    score: round(score),
    structuredStepCount,
  };
}

function computeErrorRecovery(
  input: AuditMetricsInput
): AgentAuditMetrics["errorRecovery"] {
  const lowerResponse = input.responseText.toLowerCase();
  const lowerCriteria = input.judgeCriteria.toLowerCase();

  const asksClarifyingQuestion =
    input.responseText.includes("?") &&
    /\b(could you|can you|clarif|which|when|where|what exact|should it|do you)\b/.test(
      lowerResponse
    );

  const expectsUnavailableAck =
    /not available|does not exist|doesn't exist|isn't available|unavailable|not currently supported/.test(
      lowerCriteria
    );
  const unavailableToolAcknowledged = expectsUnavailableAck
    ? /not available|isn't available|unavailable|not currently supported|not (yet )?supported/.test(
        lowerResponse
      )
    : null;

  const expectsClarification =
    /ambig|clarif|may ask|genuinely ambiguous|not sure/.test(lowerCriteria);

  let recoveryNeedDetected = false;
  let score: number;
  if (expectsUnavailableAck) {
    recoveryNeedDetected = true;
    score = unavailableToolAcknowledged ? 1 : 0;
  } else if (expectsClarification) {
    recoveryNeedDetected = true;
    score = asksClarifyingQuestion ? 1 : 0.5;
  } else {
    score = 1;
  }

  return {
    score: round(score),
    recoveryNeedDetected,
    asksClarifyingQuestion,
    unavailableToolAcknowledged,
  };
}

/**
 * A^2E tool_hallucination: tool calls whose names are not in the spec the
 * sidekick was given. Null when the spec is unknown to the caller.
 */
function computeToolHallucination(
  input: AuditMetricsInput
): AgentAuditMetrics["toolHallucination"] {
  if (!input.availableToolNames) {
    return null;
  }
  const available = new Set(input.availableToolNames);
  const unknownToolNames = Array.from(
    new Set(
      input.toolCalls
        .map((toolCall) => toolCall.name)
        .filter((name) => !available.has(name))
    )
  );
  const totalCalls = input.toolCalls.length;
  const score =
    totalCalls === 0 ? 1 : clamp01(1 - unknownToolNames.length / totalCalls);
  return {
    hallucinatedCalls: unknownToolNames.length,
    unknownToolNames,
    score: round(score),
  };
}

/** A^2E elapsed_time bands over the sidekick's model latency. */
function computeElapsedTime(
  input: AuditMetricsInput
): AgentAuditMetrics["elapsedTime"] {
  if (input.modelTimeMs === undefined) {
    return null;
  }
  const modelTimeMs = input.modelTimeMs;
  let band: "fast" | "medium" | "slow";
  let score: number;
  if (modelTimeMs < ELAPSED_FAST_MAX_MS) {
    band = "fast";
    score = 1;
  } else if (modelTimeMs < ELAPSED_SLOW_MIN_MS) {
    band = "medium";
    score = 0.7;
  } else {
    band = "slow";
    score = 0.4;
  }
  return { band, score, modelTimeMs };
}

/**
 * A^2E effectiveness-efficiency trade-off:
 * Q_h = 1 - sqrt(T_hat^2 + (1 - S_hat)^2) / sqrt(2), in [0, 1]; 1 means full
 * effectiveness at zero time cost.
 */
function computeEffectivenessEfficiencyTradeOff(
  input: AuditMetricsInput
): AgentAuditMetrics["effectivenessEfficiencyTradeOff"] {
  if (
    input.effectivenessScore === undefined ||
    input.modelTimeMs === undefined
  ) {
    return null;
  }
  const normalizedEffectiveness = clamp01(input.effectivenessScore / 3);
  const normalizedTimeMs = clamp01(input.modelTimeMs / ELAPSED_SLOW_MIN_MS);
  const score = clamp01(
    1 -
      Math.sqrt(normalizedTimeMs ** 2 + (1 - normalizedEffectiveness) ** 2) /
        Math.sqrt(2)
  );
  return {
    score: round(score),
    normalizedEffectiveness: round(normalizedEffectiveness),
    normalizedTimeMs: round(normalizedTimeMs),
  };
}

/**
 * Compute A^2E-style audit metrics from a sidekick execution trace. Scores are
 * parameter-free proxies in [0, 1]; `grade` maps the aggregate to 0-3.
 */
export function computeAgentAuditMetrics(
  input: AuditMetricsInput
): AgentAuditMetrics {
  const toolUse = computeToolUse(input);
  const executionEfficiency = computeExecutionEfficiency(input);
  const taskPlanning = computeTaskPlanning(input);
  const errorRecovery = computeErrorRecovery(input);
  const toolHallucination = computeToolHallucination(input);
  const elapsedTime = computeElapsedTime(input);
  const effectivenessEfficiencyTradeOff =
    computeEffectivenessEfficiencyTradeOff(input);

  const overall = clamp01(
    WEIGHT_TOOL_USE * toolUse.score +
      WEIGHT_PLANNING * taskPlanning.score +
      WEIGHT_RECOVERY * errorRecovery.score +
      WEIGHT_EFFICIENCY * executionEfficiency.score
  );

  return {
    toolUse,
    executionEfficiency,
    taskPlanning,
    errorRecovery,
    toolHallucination,
    elapsedTime,
    effectivenessEfficiencyTradeOff,
    overall: round(overall),
    grade: Math.round(overall * 3),
  };
}

/** Compact one-line summary for logging and sidekick-on-sidekick analysis. */
export function summarizeAgentAuditMetrics(metrics: AgentAuditMetrics): string {
  const parts = [
    `toolUse=${metrics.toolUse.score}`,
    `efficiency=${metrics.executionEfficiency.score}`,
    `planning=${metrics.taskPlanning.score}`,
    `recovery=${metrics.errorRecovery.score}`,
  ];
  if (metrics.toolHallucination) {
    parts.push(`hallucination=${metrics.toolHallucination.score}`);
  }
  if (metrics.elapsedTime) {
    parts.push(`elapsed=${metrics.elapsedTime.band}`);
  }
  if (metrics.effectivenessEfficiencyTradeOff) {
    parts.push(`tradeOff=${metrics.effectivenessEfficiencyTradeOff.score}`);
  }
  parts.push(`overall=${metrics.overall}`, `grade=${metrics.grade}/3`);
  return parts.join(", ");
}
