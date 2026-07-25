import type { AgentActionSpecification } from "@app/lib/actions/types/agent";
import { toTools } from "@app/lib/api/llm/utils/openai_like/chat/conversation_to_openai";
import {
  gateSpecifications,
  lastUserQuery,
} from "@app/lib/api/llm/utils/openai_like/tool_gating";
import type { ModelConversationTypeMultiActions } from "@app/types/assistant/generation";
import { describe, expect, it } from "vitest";

// Specs used across the gating tests: one always-available tool plus two
// deferred (MCP-style) tools with disjoint vocabularies.
function makeSpec(
  name: string,
  description: string,
  deferLoading = false
): AgentActionSpecification {
  return {
    name,
    description,
    deferLoading: deferLoading ? true : undefined,
    inputSchema: { type: "object", properties: {}, required: [] },
  };
}

const SPECS: AgentActionSpecification[] = [
  makeSpec("core_tool", "Run the agent main workflow"),
  makeSpec("search_slack", "Search Slack messages by keyword", true),
  makeSpec("create_jira_ticket", "Create a Jira ticket", true),
];

function toolNames(tools: ReturnType<typeof toTools>): string[] {
  return tools.map((t) => t.function.name);
}

describe("toTools (OpenAI-like dynamic tool gating)", () => {
  it("serializes every tool when no query is provided (backward compatible)", () => {
    // No query -> identical to the previous behavior: all specs serialized.
    const tools = toTools(SPECS);
    expect(toolNames(tools)).toEqual([
      "core_tool",
      "search_slack",
      "create_jira_ticket",
    ]);
  });

  it("keeps the eager tool plus only the deferred tools matching the query", () => {
    const tools = toTools(SPECS, "find messages in slack about the launch");
    // create_jira_ticket shares no vocabulary with the query, so it is gated out
    // and its schema is not serialized for this turn.
    expect(toolNames(tools)).toEqual(["core_tool", "search_slack"]);
  });

  it("keeps a force-called tool even when the query does not surface it", () => {
    const tools = toTools(
      SPECS,
      "find messages in slack about the launch",
      "create_jira_ticket"
    );
    expect(toolNames(tools)).toEqual([
      "core_tool",
      "search_slack",
      "create_jira_ticket",
    ]);
  });

  it("returns all specs when none are deferred, regardless of query", () => {
    const eagerOnly: AgentActionSpecification[] = [
      makeSpec("core_tool", "Run the agent main workflow"),
      makeSpec("other_tool", "Do something else"),
    ];
    expect(toolNames(toTools(eagerOnly, "anything"))).toEqual([
      "core_tool",
      "other_tool",
    ]);
  });
});

describe("gateSpecifications", () => {
  it("keeps only eager + forced tools when the query is empty", () => {
    const gated = gateSpecifications(SPECS, "", {
      forceToolCall: "create_jira_ticket",
    });
    expect(gated.map((s) => s.name)).toEqual([
      "core_tool",
      "create_jira_ticket",
    ]);
  });

  it("respects the topK cap on deferred tools", () => {
    const specs: AgentActionSpecification[] = [
      makeSpec("core_tool", "Run the agent main workflow"),
      // Three deferred tools that all match the query "slack".
      makeSpec("slack_search", "Search Slack", true),
      makeSpec("slack_post", "Post to Slack", true),
      makeSpec("slack_read", "Read Slack", true),
    ];
    const gated = gateSpecifications(specs, "slack", { topK: 2 });
    // core_tool (eager) plus at most two of the deferred Slack tools.
    const names = gated.map((s) => s.name);
    expect(names).toContain("core_tool");
    expect(names.filter((n) => n !== "core_tool")).toHaveLength(2);
  });
});

describe("lastUserQuery", () => {
  it("returns the text of the most recent user message", () => {
    const conversation: ModelConversationTypeMultiActions = {
      messages: [
        {
          role: "user",
          name: "u1",
          content: [{ type: "text", text: "first turn" }],
        },
        {
          role: "user",
          name: "u1",
          content: [
            { type: "text", text: "second turn" },
            { type: "text", text: "about slack" },
          ],
        },
      ],
    };
    expect(lastUserQuery(conversation)).toBe("second turn about slack");
  });

  it("returns an empty string when there is no user message", () => {
    const conversation: ModelConversationTypeMultiActions = { messages: [] };
    expect(lastUserQuery(conversation)).toBe("");
  });
});
