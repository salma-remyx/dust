// Canary-tools diagnostic for MCP tool selection.
//
// Complements the BM25 recall harness (run.ts), which only checks whether the
// correct tool is *retrievable* by the lexical index — it never asks why a
// selector picks the wrong tool. Canary tools probe one step further: they
// measure whether a tool selector stays on the correct tool when decoy tools,
// each engineered to exploit one specific selection weakness, are planted in
// the corpus. A six-type weakness taxonomy turns a binary "wrong tool" outcome
// into a per-type susceptibility profile (CSR — canary susceptibility rate).
//
// Adapted from "Diagnosing Tool-Selection Reasoning in LLM Agents with Canary
// Tools" (arXiv:2608.04719). The paper's LLM model-selection and judge are the
// auxiliary components replaced here: selection goes through an injectable
// `selectTool` seam whose default is the harness's existing BM25 ranker (a
// parameter-free lexical proxy), so the canary run reuses the same retrieval
// path as run.ts. Swap `selectTool` for a real model call to measure reasoning
// (rather than lexical) susceptibility — the engine is selector-agnostic. The
// paper's 8-model / 8,640-run benchmark is intentionally out of scope; that
// evaluation belongs in a downstream PR once a model-callable harness exists.
//
// Usage: npx tsx scripts/mcp_bm25/canary_tools.ts   (from the front/ directory)

import { fileURLToPath } from "node:url";

import { buildIndex, rank } from "@app/scripts/mcp_bm25/bm25";
import type { ServerEntry } from "@app/scripts/mcp_bm25/corpus";
import { buildDocs } from "@app/scripts/mcp_bm25/corpus";
import type { JSONSchema7 } from "json-schema";

// The six canary weakness types from the paper's taxonomy. Each probes a
// distinct way a tool selector can be misled by surface description alone.
export type CanaryType =
  | "semantic_decoy"
  | "parameter_trap"
  | "capability_mirage"
  | "prerequisite_blindness"
  | "temporal_decoy"
  | "granularity_trap";

export const CANARY_TYPES: ReadonlyArray<{ type: CanaryType; label: string }> =
  [
    { type: "semantic_decoy", label: "Semantic decoy" },
    { type: "parameter_trap", label: "Parameter trap" },
    { type: "capability_mirage", label: "Capability mirage" },
    { type: "prerequisite_blindness", label: "Prerequisite blindness" },
    { type: "temporal_decoy", label: "Temporal decoy" },
    { type: "granularity_trap", label: "Granularity trap" },
  ];

// A canary probe is an MCP tool (same {name, description, inputSchema} contract
// the corpus is built from) tagged with the weakness it probes.
export interface CanaryProbe {
  tool: ServerEntry["tools"][number];
  type: CanaryType;
}

export interface CanaryTask {
  query: string;
  // server-qualified correct tool, e.g. "mail.send" (matches buildDocs names).
  expected: string;
}

export type SelectionOutcome =
  | { kind: "robust" }
  | { kind: "canary"; type: CanaryType }
  | { kind: "off_target" };

export interface SusceptibilityProfile {
  tasks: number;
  robust: number;
  offTarget: number;
  canary: number;
  byType: Record<CanaryType, { trapped: number; total: number }>;
  // Overall canary susceptibility rate: fraction of tasks where any canary was
  // selected instead of the correct tool.
  csr: number;
}

// A tool selector maps a query + available tools to the single tool name it
// would invoke. Injected so a real model call can replace the default proxy.
export type SelectTool = (
  query: string,
  servers: ReadonlyArray<ServerEntry>
) => string;

// Default selector: the harness's BM25 top-1, a parameter-free lexical proxy.
// Reuses buildDocs/buildIndex/rank so the canary run shares the recall path.
// Re-indexes per call (fine for a diagnostic of a few hundred tasks).
export const lexicalSelectTool: SelectTool = (query, servers) => {
  const ranked = rank(query, buildIndex(buildDocs([...servers])));
  return ranked[0]?.name ?? "(none)";
};

const CANARY_SERVER_NAME = "canary";

// Returns a new corpus with a synthetic canary server appended, plus a map from
// each planted canary's doc name ("canary.<tool>") back to its weakness type.
export function plantCanaries(
  servers: ReadonlyArray<ServerEntry>,
  probes: ReadonlyArray<CanaryProbe>
): { servers: ServerEntry[]; canaryTypeByName: Map<string, CanaryType> } {
  const canaryTypeByName = new Map<string, CanaryType>();
  // Mutable element-typed array: ServerEntry["tools"] is ReadonlyArray, so we
  // build from the element type and assign into the readonly field below.
  const tools: ServerEntry["tools"][number][] = [];
  for (const probe of probes) {
    canaryTypeByName.set(
      `${CANARY_SERVER_NAME}.${probe.tool.name}`,
      probe.type
    );
    tools.push(probe.tool);
  }
  const withCanaries: ServerEntry[] = [
    ...servers,
    { name: CANARY_SERVER_NAME, tools },
  ];
  return { servers: withCanaries, canaryTypeByName };
}

export function classifySelection(args: {
  selected: string;
  expected: string;
  canaryTypeByName: Map<string, CanaryType>;
}): SelectionOutcome {
  if (args.selected === args.expected) {
    return { kind: "robust" };
  }
  const type = args.canaryTypeByName.get(args.selected);
  if (type !== undefined) {
    return { kind: "canary", type };
  }
  return { kind: "off_target" };
}

function emptyByType(): Record<CanaryType, { trapped: number; total: number }> {
  return {
    semantic_decoy: { trapped: 0, total: 0 },
    parameter_trap: { trapped: 0, total: 0 },
    capability_mirage: { trapped: 0, total: 0 },
    prerequisite_blindness: { trapped: 0, total: 0 },
    temporal_decoy: { trapped: 0, total: 0 },
    granularity_trap: { trapped: 0, total: 0 },
  };
}

export function runCanaryDiagnostic(args: {
  servers: ReadonlyArray<ServerEntry>;
  tasks: ReadonlyArray<CanaryTask>;
  probes: ReadonlyArray<CanaryProbe>;
  selectTool?: SelectTool;
}): SusceptibilityProfile {
  const selectTool = args.selectTool ?? lexicalSelectTool;
  const { servers, canaryTypeByName } = plantCanaries(
    args.servers,
    args.probes
  );

  let robust = 0;
  let offTarget = 0;
  let canary = 0;
  const byType = emptyByType();

  for (const task of args.tasks) {
    const selected = selectTool(task.query, servers);
    const outcome = classifySelection({
      selected,
      expected: task.expected,
      canaryTypeByName,
    });
    switch (outcome.kind) {
      case "robust":
        robust++;
        break;
      case "off_target":
        offTarget++;
        break;
      case "canary": {
        canary++;
        byType[outcome.type].trapped++;
        break;
      }
    }
    for (const { type } of CANARY_TYPES) {
      byType[type].total++;
    }
  }

  const tasks = args.tasks.length;
  return {
    tasks,
    robust,
    offTarget,
    canary,
    byType,
    csr: tasks === 0 ? 0 : canary / tasks,
  };
}

// --- Demo probes + fixture for the standalone run ---------------------------
// All six probes borrow vocabulary from the same "send an email" intent so each
// weakness type is exercised against one realistic tool-selection task.

function probe(
  name: string,
  description: string,
  type: CanaryType,
  properties: Record<string, JSONSchema7> = {}
): CanaryProbe {
  const inputSchema: JSONSchema7 = { type: "object", properties };
  return { type, tool: { name, description, inputSchema } };
}

export const DEMO_PROBES: CanaryProbe[] = [
  probe(
    "log_email_intent",
    "Send a record of an email you intend to write to the activity log.",
    "semantic_decoy"
  ),
  probe(
    "send_email_verified",
    "Send an email only after the caller supplies a verified outbound relay token.",
    "parameter_trap"
  ),
  probe(
    "send_any_message",
    "Send an email to any contact on any channel instantly and reliably.",
    "capability_mirage"
  ),
  probe(
    "send_email_draft",
    "Send an email from a previously approved draft id without re-opening it.",
    "prerequisite_blindness"
  ),
  probe(
    "send_email_yesterday",
    "Send an email back-dated to the previous calendar day for record keeping.",
    "temporal_decoy"
  ),
  probe(
    "send_email_to_everyone",
    "Send the same email to every contact in the address book in one batch.",
    "granularity_trap"
  ),
];

const DEMO_SERVERS: ServerEntry[] = [
  {
    name: "mail",
    tools: [
      {
        name: "send",
        description: "Send an email to one or more recipients.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "list",
        description: "List recent emails in the inbox.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  },
];

const DEMO_TASKS: CanaryTask[] = [
  { query: "send an email to the team", expected: "mail.send" },
  { query: "email the hiring manager", expected: "mail.send" },
];

function out(line: string): void {
  process.stdout.write(line + "\n");
}

function main(): void {
  const profile = runCanaryDiagnostic({
    servers: DEMO_SERVERS,
    tasks: DEMO_TASKS,
    probes: DEMO_PROBES,
  });

  out(
    `Canary diagnostic: ${profile.tasks} tasks, ${DEMO_PROBES.length} probes ` +
      `(lexical proxy selector)\n`
  );
  out("weakness type".padEnd(24) + "trapped".padStart(8) + "  csr");
  out("-".repeat(40));
  for (const { type, label } of CANARY_TYPES) {
    const { trapped, total } = profile.byType[type];
    const typeCsr = total === 0 ? 0 : trapped / total;
    out(
      label.padEnd(24) + String(trapped).padStart(8) + "  " + typeCsr.toFixed(2)
    );
  }
  out("-".repeat(40));
  out(
    `CSR: ${profile.csr.toFixed(2)}  |  robust: ${profile.robust}/${profile.tasks}` +
      `  |  off-target: ${profile.offTarget}`
  );
  out(
    "\nNote: the lexical proxy measures retrieval robustness to canary pressure." +
      " Plug a model into selectTool to measure reasoning susceptibility."
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
