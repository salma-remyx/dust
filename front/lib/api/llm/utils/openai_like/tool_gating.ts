// Dynamic tool gating for the OpenAI-like (non-Anthropic) provider serializers.
//
// Adapted from "Tool Attention Is All You Need: Dynamic Tool Gating and Lazy
// Schema Loading for Eliminating the MCP/Tools Tax in Scalable Agentic
// Workflows" (arXiv:2604.21816). The paper's core insight is that eagerly
// serializing every tool's JSON schema on every turn ("the Tools Tax") can be
// cut by selecting, per turn, only the tools relevant to the user's intent.
//
// The Anthropic path already applies this idea natively: deferred tools carry
// `defer_loading` and are surfaced on demand through a tool-search tool. The
// OpenAI-like APIs have no equivalent deferred-loading primitive, so this
// module applies the paper's *dynamic gating* half of the mechanism instead:
// before serialization, the deferred tools are ranked against the user's latest
// message with the same BM25 tool-search signal the team already invested in
// (front/scripts/mcp_bm25), and only the matched subset is serialized.
//
// Mode-2 substitution (called out for honesty): the team's BM25 ranker lives in
// front/scripts/mcp_bm25/ as a diagnostic harness. Production code under lib/
// has no precedent for importing from scripts/ (and scripts/ is not guaranteed
// to ship in the app bundle), so the ranker is re-implemented here with the
// same constants (k1=1.2, b=0.75) and the same tokenizer as the harness. The
// paper's *lazy schema loading* half (a tool-search tool that discovers tools
// on demand) is intentionally out of scope: it relies on an Anthropic-only API
// primitive and is not portable to the OpenAI-like providers this gates.

import type { AgentActionSpecification } from "@app/lib/actions/types/agent";
import {
  isTextContent,
  type ModelConversationTypeMultiActions,
} from "@app/types/assistant/generation";
import type { JSONSchema7Definition } from "json-schema";

// --- BM25 ranker (mirrors front/scripts/mcp_bm25/bm25.ts) -------------------

const K1 = 1.2;
const B = 0.75;

// Lowercase, split on non-alphanumeric, then crude singularization so that
// doc~docs, file~files, sheet~sheets match. Identical to the harness tokenizer.
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)
    .map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t));
}

interface Bm25Index {
  // Tool name -> ordered token list for its search text.
  tokensByName: Map<string, string[]>;
  // Tool names in original order.
  names: string[];
  avgdl: number;
  idf: Map<string, number>;
}

function buildIndex(specs: AgentActionSpecification[]): Bm25Index {
  const tokensByName = new Map<string, string[]>();
  const names: string[] = [];
  let totalLength = 0;
  for (const spec of specs) {
    const tokens = tokenize(toolSearchText(spec));
    tokensByName.set(spec.name, tokens);
    names.push(spec.name);
    totalLength += tokens.length;
  }

  const n = names.length;
  const avgdl = n > 0 ? totalLength / n : 0;

  const df = new Map<string, number>();
  for (const name of names) {
    const tokens = tokensByName.get(name) ?? [];
    for (const t of new Set(tokens)) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }

  const idf = new Map<string, number>();
  for (const [t, count] of df) {
    idf.set(t, Math.log(1 + (n - count + 0.5) / (count + 0.5)));
  }

  return { tokensByName, names, avgdl, idf };
}

function scoreDocument(
  queryTokens: string[],
  docTokens: string[],
  idx: Bm25Index
): number {
  const tf = new Map<string, number>();
  for (const t of docTokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }

  const dl = docTokens.length;
  let total = 0;
  for (const q of queryTokens) {
    const f = tf.get(q);
    if (!f) {
      continue;
    }
    const idf = idx.idf.get(q) ?? 0;
    total += (idf * (f * (K1 + 1))) / (f + K1 * (1 - B + B * (dl / idx.avgdl)));
  }
  return total;
}

// --- Search text (mirrors front/scripts/mcp_bm25/corpus.ts) -----------------

function collectSchemaText(def: JSONSchema7Definition | undefined): string[] {
  if (def === undefined || typeof def === "boolean") {
    return [];
  }

  const parts: string[] = [];

  if (typeof def.description === "string") {
    parts.push(def.description);
  }
  if (def.enum) {
    parts.push(
      def.enum.filter((e): e is string => typeof e === "string").join(" ")
    );
  }
  if (def.properties) {
    for (const [key, child] of Object.entries(def.properties)) {
      parts.push(key);
      parts.push(...collectSchemaText(child));
    }
  }
  if (def.items) {
    const items = Array.isArray(def.items) ? def.items : [def.items];
    for (const item of items) {
      parts.push(...collectSchemaText(item));
    }
  }
  for (const branch of [def.anyOf, def.oneOf, def.allOf]) {
    if (branch) {
      for (const sub of branch) {
        parts.push(...collectSchemaText(sub));
      }
    }
  }

  return parts;
}

function toolSearchText(spec: AgentActionSpecification): string {
  return [
    spec.name,
    spec.description,
    ...collectSchemaText(spec.inputSchema),
  ].join(" ");
}

// --- Query extraction ------------------------------------------------------

/**
 * Returns the concatenated text of the most recent user message in the
 * conversation, used as the per-turn intent signal for tool gating. Returns an
 * empty string when there is no user message (e.g. a force-call turn), in which
 * case callers keep their default (ungated) serialization.
 */
export function lastUserQuery(
  conversation: ModelConversationTypeMultiActions
): string {
  for (let i = conversation.messages.length - 1; i >= 0; i -= 1) {
    const message = conversation.messages[i];
    if (message && message.role === "user") {
      return message.content
        .filter(isTextContent)
        .map((c) => c.text)
        .join(" ")
        .trim();
    }
  }
  return "";
}

// --- Gating ----------------------------------------------------------------

export interface ToolGateOptions {
  /** Maximum number of deferred tools to surface for a turn. */
  topK?: number;
  /** BM25 score floor; deferred tools below it are not surfaced. */
  minScore?: number;
  /**
   * A tool the model is being forced to call this turn. It is always kept, even
   * when BM25 does not surface it, since the model cannot discover a gated-out
   * tool through an OpenAI-like API.
   */
  forceToolCall?: string;
}

/**
 * Default cap on how many deferred tools a single turn surfaces. Keeps the
 * serialized payload bounded while leaving room for multi-tool turns.
 */
export const DEFAULT_DEFERRED_TOOL_TOP_K = 16;

/**
 * Selects which tool specifications to serialize for a turn.
 *
 * Eager tools (`deferLoading` not set) are always kept — they are the agent's
 * always-available tools. Deferred tools (`deferLoading: true`, i.e. the MCP
 * tools that exist to be surfaced on demand) are ranked against `query` with
 * BM25 over their name + description + input schema, and only those above
 * `minScore` (up to `topK`) are kept. A `forceToolCall` tool is always kept.
 *
 * With an empty query only eager + forced tools are returned: deferred tools
 * carry no relevance signal for the turn, so paying their schema-token tax would
 * buy nothing. Callers that want unchanged (ungated) behavior simply pass no
 * query.
 *
 * The returned array preserves the original `specifications` order so the
 * serialized bytes are stable for the kept subset.
 */
export function gateSpecifications(
  specifications: AgentActionSpecification[],
  query: string,
  options: ToolGateOptions = {}
): AgentActionSpecification[] {
  const hasDeferred = specifications.some((s) => s.deferLoading === true);
  // No deferred tools -> nothing to gate; return the input unchanged.
  if (!hasDeferred) {
    return specifications;
  }

  const kept = new Set<string>();
  for (const s of specifications) {
    if (!s.deferLoading) {
      kept.add(s.name);
    }
  }
  if (options.forceToolCall) {
    kept.add(options.forceToolCall);
  }

  const trimmed = query.trim();
  if (trimmed) {
    const deferred = specifications.filter((s) => s.deferLoading === true);
    const idx = buildIndex(deferred);
    const queryTokens = tokenize(trimmed);
    const topK = options.topK ?? DEFAULT_DEFERRED_TOOL_TOP_K;
    const minScore = options.minScore ?? 0;

    const ranked = idx.names
      .map((name) => ({
        name,
        score: scoreDocument(
          queryTokens,
          idx.tokensByName.get(name) ?? [],
          idx
        ),
      }))
      .filter((r) => r.score > minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    for (const r of ranked) {
      kept.add(r.name);
    }
  }

  return specifications.filter((s) => kept.has(s.name));
}
