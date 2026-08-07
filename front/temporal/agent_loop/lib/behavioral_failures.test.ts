import {
  BehavioralFailureMonitor,
  DEFAULT_TOOL_CALL_LOOP_THRESHOLD,
} from "@app/temporal/agent_loop/lib/behavioral_failures";
import {
  buildStepToolCallSignature,
  type StepToolCall,
} from "@app/temporal/agent_loop/lib/create_tool_actions";
import { describe, expect, it } from "vitest";

describe("buildStepToolCallSignature", () => {
  it("is empty when no tools were called", () => {
    expect(buildStepToolCallSignature([])).toBe("");
  });

  it("is insensitive to the order of calls within a step", () => {
    const aFirst: StepToolCall[] = [
      { name: "search", args: { q: "a" } },
      { name: "read", args: { id: 1 } },
    ];
    const bFirst: StepToolCall[] = [
      { name: "read", args: { id: 1 } },
      { name: "search", args: { q: "a" } },
    ];

    expect(buildStepToolCallSignature(aFirst)).toBe(
      buildStepToolCallSignature(bFirst)
    );
  });

  it("is insensitive to argument object key order", () => {
    const ordered = buildStepToolCallSignature([
      { name: "search", args: { a: 1, b: 2 } },
    ]);
    const reordered = buildStepToolCallSignature([
      { name: "search", args: { b: 2, a: 1 } },
    ]);

    expect(ordered).toBe(reordered);
  });

  it("changes when the arguments change", () => {
    const first = buildStepToolCallSignature([
      { name: "search", args: { q: "a" } },
    ]);
    const second = buildStepToolCallSignature([
      { name: "search", args: { q: "b" } },
    ]);

    expect(first).not.toBe(second);
  });
});

describe("BehavioralFailureMonitor", () => {
  it("does not flag a loop below the threshold", () => {
    const monitor = new BehavioralFailureMonitor();
    const signature = 'search:{"q":"a"}';

    expect(monitor.observeStep(1, signature)).toEqual([]);
    expect(monitor.observeStep(2, signature)).toEqual([]);
  });

  it("flags a loop once the same signature repeats for the threshold", () => {
    const monitor = new BehavioralFailureMonitor();
    const signature = 'search:{"q":"a"}';

    expect(monitor.observeStep(1, signature)).toEqual([]);
    expect(monitor.observeStep(2, signature)).toEqual([]);
    expect(monitor.observeStep(3, signature)).toEqual([
      {
        type: "tool_call_loop",
        step: 3,
        repeatCount: DEFAULT_TOOL_CALL_LOOP_THRESHOLD,
      },
    ]);
  });

  it("reports a loop only once per stuck run (edge-triggered)", () => {
    const monitor = new BehavioralFailureMonitor();
    const signature = 'search:{"q":"a"}';

    monitor.observeStep(1, signature);
    monitor.observeStep(2, signature);
    expect(monitor.observeStep(3, signature)).toHaveLength(1);
    // Still stuck on step 4 — should not fire again.
    expect(monitor.observeStep(4, signature)).toEqual([]);
  });

  it("resets the streak when the agent does something else", () => {
    const monitor = new BehavioralFailureMonitor();
    const signature = 'search:{"q":"a"}';

    monitor.observeStep(1, signature);
    monitor.observeStep(2, signature);
    // A different call breaks the loop.
    expect(monitor.observeStep(3, 'search:{"q":"b"}')).toEqual([]);
    // Starting to repeat the new call should need a full streak again.
    expect(monitor.observeStep(4, 'search:{"q":"b"}')).toEqual([]);
  });

  it("resets the streak on a step with no tool calls", () => {
    const monitor = new BehavioralFailureMonitor();
    const signature = 'search:{"q":"a"}';

    monitor.observeStep(1, signature);
    monitor.observeStep(2, signature);
    // The agent produced a final answer (no calls) — not a loop.
    expect(monitor.observeStep(3, "")).toEqual([]);
    expect(monitor.observeStep(4, signature)).toEqual([]);
    expect(monitor.observeStep(5, signature)).toEqual([]);
    expect(monitor.observeStep(6, signature)).toEqual([
      { type: "tool_call_loop", step: 6, repeatCount: 3 },
    ]);
  });

  it("honors a custom threshold", () => {
    const monitor = new BehavioralFailureMonitor(2);
    const signature = 'search:{"q":"a"}';

    expect(monitor.observeStep(1, signature)).toEqual([]);
    expect(monitor.observeStep(2, signature)).toEqual([
      { type: "tool_call_loop", step: 2, repeatCount: 2 },
    ]);
  });
});

describe("behavioral failure detection integration", () => {
  // Exercises the wiring end-to-end: the per-step signature produced by the
  // existing create_tool_actions activity (buildStepToolCallSignature) drives
  // the monitor that the agent-loop workflow consults each step.
  it("detects a loop from real per-step tool-call signatures", () => {
    const stuckCall: StepToolCall = { name: "search", args: { q: "same" } };
    const progressingCalls: StepToolCall[] = [
      { name: "search", args: { q: "same" } },
      { name: "search", args: { q: "different" } },
      { name: "search", args: { q: "another" } },
    ];

    const monitor = new BehavioralFailureMonitor();
    const stuckSignature = buildStepToolCallSignature([stuckCall]);

    // Three identical steps -> loop detected.
    const detections: { step: number; repeatCount: number }[] = [];
    for (const step of [1, 2, 3]) {
      for (const d of monitor.observeStep(step, stuckSignature)) {
        detections.push({ step: d.step, repeatCount: d.repeatCount });
      }
    }
    expect(detections).toEqual([{ step: 3, repeatCount: 3 }]);

    // A healthy agent that changes its arguments each step never trips it.
    const healthyMonitor = new BehavioralFailureMonitor();
    const healthyDetections = progressingCalls.flatMap((call, i) =>
      healthyMonitor
        .observeStep(i + 1, buildStepToolCallSignature([call]))
        .map((d) => d.step)
    );
    expect(healthyDetections).toEqual([]);
  });
});
