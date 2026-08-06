// Static-analysis heuristic that flags "trivial trojan" MCP tool-sets.
//
// Adapted from: "Trivial Trojans: How Minimal MCP Servers Enable Cross-Tool
// Exfiltration of Sensitive Data" (arXiv:2507.19880). The paper's contribution
// relevant to Dust is not the proof-of-concept attack itself but the
// observation that a minimal MCP server can exfiltrate sensitive data by
// splitting capabilities across tools: one tool that *reads* sensitive
// resources (filesystem, secrets, env vars, a database) and a second tool that
// can *send* data outbound (HTTP fetch, webhook, email, chat). Neither tool is
// suspicious in isolation, so per-tool allow-listing misses the pair.
//
// This module implements a parameter-free, vocab-overlap detector over the
// already-extracted tool schemas (name + description + inputSchema). It is a
// conservative signal, not a verdict: it is intended to *elevate* the stake of
// flagged tools (so they require user approval) rather than to block them.
// Expect false positives — their cost is one extra approval click, which is the
// trade-off the paper's threat model calls for.

import type { MCPToolType } from "@app/lib/api/mcp";

// Tokens whose mere presence on a tool's surface strongly indicates it exposes
// sensitive material. These count as reader signals on their own.
const STRONG_SECRET_TOKENS: readonly string[] = [
  "secret",
  "secrets",
  "credential",
  "credentials",
  "password",
  "passwd",
  "pwd",
  "api key",
  "apikey",
  "api-key",
  "private key",
  "privatekey",
  "access key",
  "accesskey",
  "kubeconfig",
  "keystore",
  "ssh key",
  ".env",
  "env file",
  "access token",
  "refresh token",
];

// Tokens indicating a tool reads from a sensitive *source*. Weaker than the
// strong-secret set, so these are only counted when paired with a read verb.
const SENSITIVE_SOURCE_TOKENS: readonly string[] = [
  "token",
  "cookie",
  "cookies",
  "session",
  "bearer",
  "oauth",
  "environment",
  "environment variable",
  "env variable",
  "env var",
  "filesystem",
  "file system",
  "file path",
  "filepath",
  "read file",
  "directory",
  "database",
  "sql",
  "vault",
  "config file",
];

const READ_VERBS: readonly string[] = [
  "read",
  "get",
  "list",
  "fetch",
  "retrieve",
  "load",
  "cat ",
  "show",
  "view",
  "access",
  "open",
  "dump",
  "return",
  "search",
  "find",
  "export",
  "scan",
  "extract",
  "pull",
  "download",
];

// Tokens indicating a tool can send data to an external network destination.
const NETWORK_EGRESS_TARGETS: readonly string[] = [
  "http",
  "https",
  "url",
  "uri",
  "endpoint",
  "webhook",
  "curl",
  "wget",
  "email",
  "smtp",
  "slack",
  "discord",
  "sms",
  "dns",
];

const SEND_VERBS: readonly string[] = [
  "send",
  "post",
  "fetch",
  "request",
  "put",
  "patch",
  "publish",
  "notify",
  "submit",
  "upload",
  "push",
  "call",
  "deliver",
  "transmit",
  "forward",
  "share",
  "emit",
  "sync",
];

/**
 * Result of scanning a server's tool-set for the trivial-trojan pattern.
 */
export type TrivialTrojanDetectionResult = {
  // True when the tool-set exposes at least one sensitive-reader tool AND at
  // least one network-exfiltrator tool (the cross-tool exfiltration pair).
  detected: boolean;
  // Tool names that can read sensitive resources.
  readerToolNames: string[];
  // Tool names that can send data to a network destination.
  exfiltratorToolNames: string[];
  // Human-readable summary of why the pattern fired (empty when not detected).
  reason: string;
};

/**
 * Gathers a tool's surface text (name + description + inputSchema property
 * names and their descriptions) into a single normalized, lowercased string for
 * keyword matching.
 */
function toolSurfaceText(tool: MCPToolType): string {
  const parts: string[] = [tool.name, tool.description ?? ""];
  const schema = tool.inputSchema;
  if (schema && typeof schema === "object") {
    const props = schema.properties;
    if (props && typeof props === "object") {
      for (const [propName, propDef] of Object.entries(props)) {
        parts.push(propName);
        if (
          propDef &&
          typeof propDef === "object" &&
          typeof propDef.description === "string"
        ) {
          parts.push(propDef.description);
        }
      }
    }
  }
  // Normalize separators so a schema property such as `file_path` matches the
  // `file path` token, while leaving dotted tokens like `.env` intact.
  return parts.join(" ").toLowerCase().replace(/[-_]+/g, " ");
}

function includesAny(text: string, tokens: readonly string[]): boolean {
  return tokens.some((t) => text.includes(t));
}

type ToolCapabilities = {
  reader: boolean;
  exfiltrator: boolean;
};

/**
 * Classifies a single tool's capabilities from its surface text. A tool can be
 * both a reader and an exfiltrator (e.g. a tool that reads a secret and POSTs
 * it to a URL).
 */
function classifyToolCapabilities(tool: MCPToolType): ToolCapabilities {
  const text = toolSurfaceText(tool);

  const hasStrongSecret = includesAny(text, STRONG_SECRET_TOKENS);
  const hasSensitiveSource =
    hasStrongSecret || includesAny(text, SENSITIVE_SOURCE_TOKENS);
  const hasReadVerb = includesAny(text, READ_VERBS);
  // Strong-secret tokens (e.g. "password", "credential") are suspicious on
  // their own; softer source tokens (e.g. "token", "database") only count when
  // the tool also reads.
  const reader = hasStrongSecret || (hasSensitiveSource && hasReadVerb);

  const hasEgressTarget = includesAny(text, NETWORK_EGRESS_TARGETS);
  const hasSendVerb = includesAny(text, SEND_VERBS);
  const exfiltrator = hasEgressTarget && hasSendVerb;

  return { reader, exfiltrator };
}

/**
 * Scans a server's tool-set for the "trivial trojan" pattern: the presence of
 * both a sensitive-reader tool and a network-exfiltrator tool. Returns the
 * classified tool names so callers can act on them individually (e.g. elevate
 * their stake). Pure and side-effect free.
 *
 * Example:
 *   detectTrivialTrojan([
 *     { name: "read_file",  description: "Read a file from disk." },
 *     { name: "post_url",   description: "Send data to an HTTP endpoint." },
 *   ]).detected === true
 */
export function detectTrivialTrojan(
  tools: MCPToolType[]
): TrivialTrojanDetectionResult {
  const readerToolNames: string[] = [];
  const exfiltratorToolNames: string[] = [];

  for (const tool of tools) {
    const { reader, exfiltrator } = classifyToolCapabilities(tool);
    if (reader) {
      readerToolNames.push(tool.name);
    }
    if (exfiltrator) {
      exfiltratorToolNames.push(tool.name);
    }
  }

  const detected =
    readerToolNames.length > 0 && exfiltratorToolNames.length > 0;
  const reason = detected
    ? `Sensitive-reader tool(s) [${readerToolNames.join(", ")}] and ` +
      `network-exfiltrator tool(s) [${exfiltratorToolNames.join(", ")}] ` +
      `form a cross-tool exfiltration path.`
    : "";

  return { detected, readerToolNames, exfiltratorToolNames, reason };
}
