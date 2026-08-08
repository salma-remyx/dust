// Tests for the canary-tools diagnostic. Exercises the engine against the
// existing corpus contract (buildDocs from corpus.ts) and the existing labeled
// query set (QUERIES from queries.ts) — the same non-canary modules the recall
// harness (run.ts) is built on.

import {
  CANARY_TYPES,
  type CanaryProbe,
  type CanaryTask,
  type CanaryType,
  classifySelection,
  DEMO_PROBES,
  lexicalSelectTool,
  plantCanaries,
  runCanaryDiagnostic,
  type SelectTool,
} from "@app/scripts/mcp_bm25/canary_tools";
import type { ServerEntry } from "@app/scripts/mcp_bm25/corpus";
import { buildDocs } from "@app/scripts/mcp_bm25/corpus";
import { QUERIES } from "@app/scripts/mcp_bm25/queries";
import { describe, expect, it } from "vitest";

function findProbe(type: CanaryType): CanaryProbe {
  const probe = DEMO_PROBES.find((p) => p.type === type);
  if (!probe) {
    throw new Error(`missing demo probe for ${type}`);
  }
  return probe;
}

const MAIL_SERVER: ServerEntry = {
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
};

const SEMANTIC_DECOY = findProbe("semantic_decoy");

const TASKS: CanaryTask[] = [
  { query: "send an email to the team", expected: "mail.send" },
  { query: "email the hiring manager", expected: "mail.send" },
];

describe("plantCanaries + classifySelection", () => {
  it("plants canaries under a synthetic server and tags them by type", () => {
    const { servers, canaryTypeByName } = plantCanaries(
      [MAIL_SERVER],
      [SEMANTIC_DECOY]
    );
    expect(servers[servers.length - 1].name).toBe("canary");
    expect(canaryTypeByName.get("canary.log_email_intent")).toBe(
      "semantic_decoy"
    );
    // The planted corpus is consumable by the existing buildDocs contract.
    const names = buildDocs(servers).map((d) => d.name);
    expect(names).toContain("mail.send");
    expect(names).toContain("canary.log_email_intent");
  });

  it("classifies a canary pick, a correct pick, and an unrelated miss", () => {
    const { canaryTypeByName } = plantCanaries([MAIL_SERVER], [SEMANTIC_DECOY]);
    expect(
      classifySelection({
        selected: "canary.log_email_intent",
        expected: "mail.send",
        canaryTypeByName,
      })
    ).toEqual({ kind: "canary", type: "semantic_decoy" });
    expect(
      classifySelection({
        selected: "mail.send",
        expected: "mail.send",
        canaryTypeByName,
      })
    ).toEqual({ kind: "robust" });
    expect(
      classifySelection({
        selected: "mail.list",
        expected: "mail.send",
        canaryTypeByName,
      })
    ).toEqual({ kind: "off_target" });
  });
});

describe("runCanaryDiagnostic", () => {
  it("records a canary susceptibility per type when the selector is trapped", () => {
    // Selector deliberately picks the semantic decoy on every task.
    const alwaysDecoy: SelectTool = () => "canary.log_email_intent";
    const profile = runCanaryDiagnostic({
      servers: [MAIL_SERVER],
      tasks: TASKS,
      probes: [SEMANTIC_DECOY],
      selectTool: alwaysDecoy,
    });
    expect(profile.tasks).toBe(2);
    expect(profile.canary).toBe(2);
    expect(profile.robust).toBe(0);
    expect(profile.offTarget).toBe(0);
    expect(profile.csr).toBe(1);
    expect(profile.byType.semantic_decoy.trapped).toBe(2);
    // Other types were exposed but never selected.
    for (const { type } of CANARY_TYPES) {
      if (type !== "semantic_decoy") {
        expect(profile.byType[type].trapped).toBe(0);
      }
    }
  });

  it("records robust when the selector picks the correct tool", () => {
    const correct: SelectTool = () => "mail.send";
    const profile = runCanaryDiagnostic({
      servers: [MAIL_SERVER],
      tasks: TASKS,
      probes: DEMO_PROBES,
      selectTool: correct,
    });
    expect(profile.robust).toBe(2);
    expect(profile.canary).toBe(0);
    expect(profile.csr).toBe(0);
  });

  it("records off-target for a non-canary miss without counting as susceptibility", () => {
    const wrong: SelectTool = () => "mail.list";
    const profile = runCanaryDiagnostic({
      servers: [MAIL_SERVER],
      tasks: TASKS,
      probes: DEMO_PROBES,
      selectTool: wrong,
    });
    expect(profile.offTarget).toBe(2);
    expect(profile.canary).toBe(0);
    expect(profile.csr).toBe(0);
  });

  it("the lexical proxy selector reuses the BM25 ranker over a planted corpus", () => {
    const { servers } = plantCanaries([MAIL_SERVER], DEMO_PROBES);
    const selected = lexicalSelectTool("send an email to the team", servers);
    // Selection is always a real doc name produced by the existing ranker.
    const names = new Set(buildDocs(servers).map((d) => d.name));
    expect(names.has(selected)).toBe(true);
  });
});

describe("QUERIES (existing recall harness data)", () => {
  it("is a non-empty labeled set the canary engine can consume", () => {
    expect(QUERIES.length).toBeGreaterThan(0);
    // The canary task contract is the same shape as the recall harness queries.
    const asTasks: CanaryTask[] = QUERIES.slice(0, 3).map((q) => ({
      query: q.query,
      expected: q.expected,
    }));
    expect(
      asTasks.every((t) => t.query.length > 0 && t.expected.includes("."))
    ).toBe(true);
  });
});
