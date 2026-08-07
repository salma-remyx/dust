/**
 * Deterministic, telemetry-based detection of behavioral agent failures.
 *
 * Adapted from "Real-Time Detection and Repair of LLM Agent Failures"
 * (arxiv:2608.02464v1). The paper observes that a large share of mid-episode
 * agent failures can be caught from observable step telemetry alone — without an
 * expensive LLM judge — and that the most robust layer is *deterministic
 * verification*: parameter-free checks that carry no per-deployment "healthy
 * null" and produce no false alarms, so they transfer unchanged across models.
 *
 * This module ports that deterministic layer for the failure mode the agent loop
 * can observe at its step boundary: the **tool-call loop**, where the agent
 * makes the exact same tool call(s) — same tool, same arguments — on consecutive
 * steps without progressing. A healthy agent either varies its calls as results
 * come back or terminates; only a stuck agent repeats itself verbatim, so this
 * signal is zero-false-positive at a conservative repeat threshold.
 *
 * The paper's statistical layer (a one-class echo-state-network ensemble with
 * CUSUM alarms) is intentionally NOT ported here: it requires a per-deployment
 * healthy baseline that does not transfer cold (AUROC 0.527 cold vs. 0.885
 * recalibrated in the paper) and needs training infrastructure this repo does
 * not host. The deterministic checks are the high-value, transferable part.
 *
 * This module is pure and deterministic on purpose: it runs inside the Temporal
 * workflow, so it must not perform I/O, read the clock, or import anything that
 * does. Observability (logging / metrics) is the caller's responsibility — this
 * module only decides *whether* a behavioral failure is happening.
 */

/**
 * Behavioral failure modes this monitor can flag. New modes (e.g. cascading
 * tool errors) will extend this union; consumers should handle them
 * exhaustively.
 */
export type BehavioralFailureType = "tool_call_loop";

export interface BehavioralFailureDetection {
  readonly type: BehavioralFailureType;
  // The step at which the failure was confirmed.
  readonly step: number;
  // How many consecutive steps produced the identical tool-call signature.
  readonly repeatCount: number;
}

// A tool-call loop is only declared once the *same* call set has repeated for at
// least this many consecutive steps. Two identical steps can happen legitimately
// (a retried call after an interrupted step); three or more in a row, with the
// exact same arguments, is a stuck agent.
//
// `>= 3` is chosen for zero false positives: a progressing agent changes its
// arguments as tool results arrive, so it cannot produce an identical signature
// three steps running.
export const DEFAULT_TOOL_CALL_LOOP_THRESHOLD = 3;

/**
 * Detects behavioral failures from per-step tool-call telemetry.
 *
 * Feed one `observeStep` call per agent-loop step, in order, with the step's
 * tool-call signature (see `buildStepToolCallSignature` in
 * `create_tool_actions.ts`). An empty signature (no tool calls this step — the
 * model produced text, paused for approval, etc.) resets the loop streak, since
 * the agent did something other than repeat its previous calls.
 *
 * Detection is edge-triggered: a loop is reported once, when the repeat count
 * first reaches the threshold, and not again until the streak resets and
 * re-crosses it. This keeps downstream metrics from firing on every step of a
 * long stuck run.
 */
export class BehavioralFailureMonitor {
  private lastSignature: string | null = null;
  private currentStreak = 0;
  private loopAlreadyReported = false;

  constructor(
    private readonly toolCallLoopThreshold: number = DEFAULT_TOOL_CALL_LOOP_THRESHOLD
  ) {}

  observeStep(
    step: number,
    signature: string
  ): readonly BehavioralFailureDetection[] {
    // No tool calls this step: the agent generated a final answer, paused for
    // approval, or otherwise did something other than repeat its calls. Any
    // in-progress loop is broken.
    if (signature.length === 0) {
      this.reset();
      return [];
    }

    if (signature === this.lastSignature) {
      this.currentStreak += 1;
    } else {
      this.lastSignature = signature;
      this.currentStreak = 1;
      this.loopAlreadyReported = false;
    }

    if (
      !this.loopAlreadyReported &&
      this.currentStreak >= this.toolCallLoopThreshold
    ) {
      this.loopAlreadyReported = true;
      return [
        {
          type: "tool_call_loop",
          step,
          repeatCount: this.currentStreak,
        },
      ];
    }

    return [];
  }

  private reset(): void {
    this.lastSignature = null;
    this.currentStreak = 0;
    this.loopAlreadyReported = false;
  }
}
