import { Authenticator } from "@app/lib/auth";
import {
  computeAgentAuditMetrics,
  summarizeAgentAuditMetrics,
} from "@app/tests/sidekick-evals/lib/agent_audit_metrics";
import { evaluateWithJudge } from "@app/tests/sidekick-evals/lib/judge";
import type {
  MockAgentState,
  TestCase,
} from "@app/tests/sidekick-evals/lib/types";
import { describe, expect, it, vi } from "vitest";

// Stub the provider + LLM so evaluateWithJudge runs without network or DB.
vi.mock("@app/lib/api/provider_credentials", () => ({
  getLlmCredentials: vi.fn().mockResolvedValue({}),
}));

vi.mock("@app/lib/api/llm", () => ({
  getStreamLLM: vi.fn().mockResolvedValue({
    stream: () => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "text_delta",
          content: { delta: "REASONING: structured and on-target\nSCORE: 3" },
        };
      },
    }),
  }),
}));

const mockState: MockAgentState = {
  name: "Test Agent",
  description: "A test agent",
  instructions: "You are helpful.",
  model: { modelId: "gpt-5-mini" },
  tools: [],
  skills: [],
};

const testCase: TestCase = {
  scenarioId: "audit-metrics-wiring",
  mockState,
  userMessage: "Help my agent pick the right tool for the job.",
  judgeCriteria:
    "Intent is clear: add per-tool decision criteria (Notion, Slack, GitHub). Must call suggest_prompt_edits with specific criteria.",
  expectedToolCalls: ["get_agent_config", "suggest_prompt_edits"],
};

describe("computeAgentAuditMetrics", () => {
  it("rewards calling all expected tools without redundancy", () => {
    const metrics = computeAgentAuditMetrics({
      toolCalls: [
        { name: "get_agent_config", arguments: {} },
        { name: "suggest_prompt_edits", arguments: { a: 1 } },
      ],
      responseText: "1. step one\n2. step two",
      expectedToolCalls: ["get_agent_config", "suggest_prompt_edits"],
      judgeCriteria: "Must call suggest_prompt_edits with clear criteria.",
    });
    expect(metrics.toolUse.recall).toBe(1);
    expect(metrics.toolUse.redundantCalls).toBe(0);
    expect(metrics.toolUse.score).toBe(1);
  });

  it("penalizes missing expected tools", () => {
    const metrics = computeAgentAuditMetrics({
      toolCalls: [{ name: "get_agent_config", arguments: {} }],
      responseText: "ok",
      expectedToolCalls: ["get_agent_config", "suggest_prompt_edits"],
      judgeCriteria: "Must call suggest_prompt_edits.",
    });
    expect(metrics.toolUse.missingExpectedCount).toBe(1);
    expect(metrics.toolUse.recall).toBe(0.5);
  });

  it("penalizes redundant identical tool calls", () => {
    const metrics = computeAgentAuditMetrics({
      toolCalls: [
        { name: "get_agent_config", arguments: {} },
        { name: "get_agent_config", arguments: {} },
      ],
      responseText: "ok",
      expectedToolCalls: ["get_agent_config"],
      judgeCriteria: "Assess then suggest.",
    });
    expect(metrics.toolUse.redundantCalls).toBe(1);
    expect(metrics.toolUse.precision).toBe(0.5);
  });

  it("flags failure to acknowledge an unavailable tool", () => {
    const metrics = computeAgentAuditMetrics({
      toolCalls: [{ name: "get_agent_config", arguments: {} }],
      responseText: "I added HubSpot instructions for you.",
      expectedToolCalls: ["get_agent_config"],
      judgeCriteria:
        "HubSpot is NOT available. Must not suggest HubSpot instructions.",
    });
    expect(metrics.errorRecovery.recoveryNeedDetected).toBe(true);
    expect(metrics.errorRecovery.unavailableToolAcknowledged).toBe(false);
    expect(metrics.errorRecovery.score).toBe(0);
  });

  it("rewards acknowledging an unavailable tool", () => {
    const metrics = computeAgentAuditMetrics({
      toolCalls: [{ name: "get_agent_config", arguments: {} }],
      responseText: "PagerDuty is not currently supported right now.",
      expectedToolCalls: ["get_agent_config"],
      judgeCriteria:
        "PagerDuty is NOT available. Inform the user it is not available.",
    });
    expect(metrics.errorRecovery.unavailableToolAcknowledged).toBe(true);
    expect(metrics.errorRecovery.score).toBe(1);
  });

  it("maps the weighted aggregate onto the 0-3 grade", () => {
    const metrics = computeAgentAuditMetrics({
      toolCalls: [
        { name: "get_agent_config", arguments: {} },
        { name: "suggest_prompt_edits", arguments: {} },
      ],
      responseText: "1. a\n2. b\n3. c",
      expectedToolCalls: ["get_agent_config", "suggest_prompt_edits"],
      judgeCriteria: "Suggest prompt edits with clear criteria for tools.",
    });
    expect(metrics.grade).toBeGreaterThanOrEqual(2);
    expect(metrics.overall).toBeGreaterThan(0.8);
  });

  it("summarizes dimensions on a single line", () => {
    const metrics = computeAgentAuditMetrics({
      toolCalls: [{ name: "get_agent_config", arguments: {} }],
      responseText: "1. a\n2. b",
      expectedToolCalls: ["get_agent_config"],
      judgeCriteria: "Assess the agent and suggest improvements.",
    });
    expect(summarizeAgentAuditMetrics(metrics)).toMatch(
      /toolUse=.*grade=\d\/3/
    );
  });
});

describe("evaluateWithJudge audit-metrics wiring", () => {
  it("attaches dimensional audit metrics to the judge result", async () => {
    const auth = new Authenticator({
      role: "builder",
      groupModelIds: [],
      authMethod: "internal",
    });
    const toolCalls = [
      { name: "get_agent_config", arguments: {} },
      { name: "suggest_prompt_edits", arguments: { instructions: "..." } },
    ];
    const result = await evaluateWithJudge(
      auth,
      testCase,
      mockState,
      toolCalls,
      "Here is a plan:\n1. Assess current instructions\n2. Add per-tool decision criteria\nNotion, Slack, and GitHub are covered.",
      1
    );

    expect(result.finalScore).toBe(3);
    expect(result.auditMetrics).toBeDefined();
    expect(result.auditMetrics?.toolUse.recall).toBe(1);
    expect(result.auditMetrics?.toolUse.missingExpectedCount).toBe(0);
    expect(
      result.auditMetrics?.taskPlanning.structuredStepCount
    ).toBeGreaterThanOrEqual(2);
    expect(result.auditMetrics?.overall).toBeGreaterThan(0.5);
  });
});
