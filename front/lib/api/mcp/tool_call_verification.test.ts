import { describe, expect, it } from "vitest";

// Imports the call-site module (NON-NEW) to prove the wiring in run_tool.ts
// actually delegates into the verification capability.
import { verifyCompletedToolCall } from "@app/lib/api/mcp/run_tool";
import {
  buildVerificationPrompt,
  confidence,
  expectationScore,
  gradeWeight,
  modalGrade,
  parseGrade,
  rankCandidates,
  selectBestCandidate,
  verifyToolCall,
  type ToolCallVerificationGrade,
} from "@app/lib/api/mcp/tool_call_verification";

describe("verifyCompletedToolCall (LLM-as-a-Verifier wiring)", () => {
  it("returns a continuous score aggregated from the judge's graded verdicts", async () => {
    const result = await verifyCompletedToolCall(
      {
        toolConfiguration: {
          originalName: "search",
          description: "Search documents",
        },
        inputs: { query: "vpn setup" },
        toolCallResult: { content: [{ type: "text", text: "3 results" }] },
        userMessage: { content: "how do I set up vpn?" },
        agentConfiguration: { name: "support-bot" },
      },
      { judge: async () => "mostly_correct", samples: 4 }
    );

    // Granularity scaling: "mostly_correct" maps to 0.75 on the continuous scale.
    expect(result.score).toBe(0.75);
    // Repeated evaluation with identical verdicts -> zero variance.
    expect(result.variance).toBe(0);
    expect(result.confidence).toBe(0.75);
    expect(result.grade).toBe("mostly_correct");
    expect(result.sampleCount).toBe(4);
  });

  it("is a safe no-op (null score) when no judge is wired in", async () => {
    const result = await verifyCompletedToolCall({
      toolConfiguration: { originalName: "noop" },
      inputs: {},
      toolCallResult: { content: [] },
      userMessage: "hi",
      agentConfiguration: { name: "bot" },
    });

    expect(result.score).toBeNull();
    expect(result.grade).toBeNull();
    expect(result.sampleCount).toBe(0);
  });
});

describe("verification scoring", () => {
  it("maps each grade to a distinct continuous weight (granularity scaling)", () => {
    expect(gradeWeight("correct")).toBe(1);
    expect(gradeWeight("mostly_correct")).toBe(0.75);
    expect(gradeWeight("partially_correct")).toBe(0.4);
    expect(gradeWeight("incorrect")).toBe(0);
  });

  it("parses human-friendly verdict variants into canonical grades", () => {
    expect(parseGrade("correct")).toBe("correct");
    expect(parseGrade("Mostly Correct")).toBe("mostly_correct");
    expect(parseGrade("PARTIALLY-CORRECT")).toBe("partially_correct");
    expect(parseGrade("garbage")).toBeNull();
    expect(parseGrade(null)).toBeNull();
  });

  it("aggregates repeated evaluations into a mean score with variance", () => {
    const { score, variance } = expectationScore([
      "correct",
      "correct",
      "incorrect",
    ]);

    // mean of [1, 1, 0] = 0.667; variance over those weights = 0.222.
    expect(score).toBe(0.667);
    expect(variance).toBe(0.222);
    expect(modalGrade(["correct", "correct", "incorrect"])).toBe("correct");
  });

  it("erodes confidence when repeated evaluations disagree", () => {
    // High disagreement -> confidence well below the raw mean (0.667).
    expect(confidence(0.667, 0.222)).toBe(0.075);
    // Perfect agreement -> confidence equals the score.
    expect(confidence(0.75, 0)).toBe(0.75);
  });

  it("returns null scores and a null modal grade for empty input", () => {
    expect(expectationScore([])).toEqual({ score: 0, variance: 0 });
    expect(modalGrade([])).toBeNull();
  });

  it("verifies a tool call through the orchestrator with a stubbed judge", async () => {
    const prompt: string[] = [];
    const result = await verifyToolCall(
      { toolName: "calc", toolInput: { expr: "1+1" } },
      {
        judge: async (p) => {
          prompt.push(p);
          return "correct";
        },
        samples: 3,
      }
    );

    expect(result.score).toBe(1);
    expect(result.grade).toBe("correct");
    expect(result.sampleCount).toBe(3);
    // The judge was actually handed a prompt that carries the tool context.
    expect(prompt[0]).toContain("calc");
    expect(prompt[0]).toContain("1+1");
  });
});

describe("candidate ranking (cost-efficient selection)", () => {
  const resultFor = (grade: ToolCallVerificationGrade) =>
    verifyToolCall({ toolName: "t" }, { judge: async () => grade, samples: 1 });

  it("ranks candidates best-first by continuous score, nulls last", async () => {
    const scored = [
      { candidate: "partial", result: await resultFor("partially_correct") },
      { candidate: "none", result: await verifyToolCall({ toolName: "t" }) },
      { candidate: "best", result: await resultFor("mostly_correct") },
    ];

    expect(rankCandidates(scored).map((s) => s.candidate)).toEqual([
      "best",
      "partial",
      "none",
    ]);
  });

  it("selects the best candidate above threshold, else null", async () => {
    const scored = [
      { candidate: "partial", result: await resultFor("partially_correct") },
      { candidate: "best", result: await resultFor("mostly_correct") },
    ];

    expect(selectBestCandidate(scored, 0.5)?.candidate).toBe("best");
    expect(selectBestCandidate(scored, 0.9)).toBeNull();
  });
});

describe("buildVerificationPrompt", () => {
  it("surfaces the tool name, inputs, and the ordered grade scale", () => {
    const prompt = buildVerificationPrompt({
      toolName: "search",
      toolInput: { q: "x" },
      toolResult: "ok",
    });

    expect(prompt).toContain("Tool: search");
    expect(prompt).toContain("Inputs:");
    expect(prompt).toContain("- correct");
    expect(prompt).toContain("- mostly_correct");
    expect(prompt).toContain("- incorrect");
    expect(prompt).toContain("Grade:");
  });
});
