import { elevateStakesForTrivialTrojan } from "@app/lib/actions/mcp_actions";
import type {
  MCPToolType,
  ServerSideMCPToolTypeWithStakeAndRetryPolicy,
} from "@app/lib/api/mcp";
import { DEFAULT_MCP_TOOL_RETRY_POLICY } from "@app/lib/api/mcp";
import { detectTrivialTrojan } from "@app/lib/api/mcp/trivial_trojan_check";
import { describe, expect, it } from "vitest";

// Minimal valid server-side tool used to exercise the stake-elevation wiring
// in mcp_actions without standing up the full DB-backed assembly path.
function serverSideTool(
  name: string,
  description: string,
  stakeLevel: ServerSideMCPToolTypeWithStakeAndRetryPolicy["stakeLevel"],
  inputSchema?: MCPToolType["inputSchema"]
): ServerSideMCPToolTypeWithStakeAndRetryPolicy {
  return {
    name,
    description,
    inputSchema,
    availability: "manual",
    stakeLevel,
    toolServerId: "server-1",
    retryPolicy: DEFAULT_MCP_TOOL_RETRY_POLICY,
  };
}

describe("detectTrivialTrojan", () => {
  it("flags a sensitive-reader + network-exfiltrator pair", () => {
    const tools: MCPToolType[] = [
      { name: "read_secret", description: "Read a secret from the vault." },
      {
        name: "post_webhook",
        description: "Send a payload to an HTTP webhook URL.",
      },
    ];

    const result = detectTrivialTrojan(tools);

    expect(result.detected).toBe(true);
    expect(result.readerToolNames).toEqual(["read_secret"]);
    expect(result.exfiltratorToolNames).toEqual(["post_webhook"]);
    expect(result.reason).toContain("read_secret");
    expect(result.reason).toContain("post_webhook");
  });

  it("does not flag benign tool-sets with no sensitive reader", () => {
    const tools: MCPToolType[] = [
      { name: "search_docs", description: "Search the documentation." },
      {
        name: "post_webhook",
        description: "Send a payload to an HTTP webhook URL.",
      },
    ];

    expect(detectTrivialTrojan(tools).detected).toBe(false);
  });

  it("does not flag benign tool-sets with no network exfiltrator", () => {
    const tools: MCPToolType[] = [
      { name: "read_secret", description: "Read a secret from the vault." },
      { name: "create_note", description: "Create a note." },
    ];

    expect(detectTrivialTrojan(tools).detected).toBe(false);
  });

  it("treats an environment-variable reader as a sensitive reader", () => {
    const tools: MCPToolType[] = [
      {
        name: "get_environment_variables",
        description: "Read environment variables from the host.",
      },
      {
        name: "send_sms",
        description: "Send an SMS notification to a phone number.",
      },
    ];

    const result = detectTrivialTrojan(tools);
    expect(result.detected).toBe(true);
    expect(result.readerToolNames).toContain("get_environment_variables");
    expect(result.exfiltratorToolNames).toContain("send_sms");
  });

  it("detects the pattern from inputSchema property names", () => {
    const tools: MCPToolType[] = [
      {
        name: "fetch_record",
        description: "Retrieve a record.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Path to the file" },
          },
        },
      },
      {
        name: "deliver",
        description: "Deliver the result.",
        inputSchema: {
          type: "object",
          properties: {
            endpoint: { type: "string", description: "HTTP endpoint URL" },
          },
        },
      },
    ];

    const result = detectTrivialTrojan(tools);
    expect(result.detected).toBe(true);
    expect(result.readerToolNames).toContain("fetch_record");
    expect(result.exfiltratorToolNames).toContain("deliver");
  });
});

// Integration test: the detection result drives the stake machinery exported
// from the existing mcp_actions module (the production wiring used by
// buildToolConfigurationsFromRawTools for remote MCP servers).
describe("elevateStakesForTrivialTrojan (integration with mcp_actions)", () => {
  it("elevates flagged tools to high stake when the pattern is present", () => {
    const tools = [
      serverSideTool("read_secret", "Read a secret from the vault.", "low"),
      serverSideTool(
        "post_webhook",
        "Send a payload to an HTTP webhook URL.",
        "never_ask"
      ),
      serverSideTool("create_note", "Create a note.", "low"),
    ];

    const elevated = elevateStakesForTrivialTrojan(
      tools,
      detectTrivialTrojan(tools)
    );

    expect(elevated[0].stakeLevel).toBe("high");
    expect(elevated[1].stakeLevel).toBe("high");
    // Benign tool is untouched.
    expect(elevated[2].stakeLevel).toBe("low");
    // Input is not mutated (GEN5).
    expect(tools[0].stakeLevel).toBe("low");
  });

  it("leaves stakes unchanged (same array) when the pattern is absent", () => {
    const tools = [
      serverSideTool("search_docs", "Search the documentation.", "low"),
      serverSideTool("create_note", "Create a note.", "high"),
    ];

    const elevated = elevateStakesForTrivialTrojan(
      tools,
      detectTrivialTrojan(tools)
    );

    // No trojan pattern -> same references returned, stakes unchanged.
    expect(elevated).toBe(tools);
    expect(elevated[0].stakeLevel).toBe("low");
    expect(elevated[1].stakeLevel).toBe("high");
  });
});
