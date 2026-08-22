// Tests for the MCP tool-search BM25 harness, focused on the eager sparse
// index (sparse_index.ts) being a drop-in for the lazy ranker (bm25.ts): same
// tokenizer, same idf, same scores — only the cost model changes.

import {
  buildIndex,
  type Document,
  rank,
  tokenize,
} from "@app/scripts/mcp_bm25/bm25";
import { buildDocs, type ServerEntry } from "@app/scripts/mcp_bm25/corpus";
import {
  buildSparseIndex,
  rankSparse,
} from "@app/scripts/mcp_bm25/sparse_index";
import { expect, test } from "vitest";

const DOCS: Document[] = [
  {
    name: "google_drive.search_files",
    text: "search_files Search for files and folders in Google Drive by name or content query drive",
  },
  {
    name: "gmail.search_threads",
    text: "search_threads Search Gmail threads and messages by query mail labels",
  },
  {
    name: "google_sheets.copy_file",
    text: "copy_file Copy a spreadsheet file to a new location sheets spreadsheet",
  },
  {
    name: "slack.search_messages",
    text: "search_messages Search Slack messages in a channel by keyword slack channels history",
  },
];

test("sparse index reproduces the lazy ranker scores exactly", () => {
  const lazyIndex = buildIndex(DOCS);
  const sparseIndex = buildSparseIndex(DOCS);

  for (const query of [
    "search my drive files",
    "find an email about the invoice",
    "copy the spreadsheet",
    "look up slack history",
  ]) {
    const lazy = rank(query, lazyIndex);
    const sparse = rankSparse(query, sparseIndex);
    // The lazy ranker returns every document (zero-scored ones included) while
    // the sparse index returns only documents sharing a term with the query;
    // compare against the lazy prefix that carries a non-zero score.
    expect(sparse.map((r) => r.name)).toEqual(
      lazy.filter((r) => r.score > 0).map((r) => r.name)
    );
    const byName = new Map(sparse.map((r) => [r.name, r.score]));
    for (const r of lazy) {
      expect(byName.get(r.name)).toBe(r.score > 0 ? r.score : undefined);
    }
  }
});

test("sparse index returns an empty ranking when no term matches", () => {
  const sparseIndex = buildSparseIndex(DOCS);
  expect(rankSparse("zzzqqqxxx", sparseIndex)).toEqual([]);
});

test("sparse index uses the shared tokenizer", () => {
  const sparseIndex = buildSparseIndex(DOCS);
  // The crude singularization in the shared tokenizer folds "messages" and
  // "message" onto the same posting list, so the plural still matches.
  expect(rankSparse("slack message", sparseIndex)[0]?.name).toBe(
    "slack.search_messages"
  );
  expect(tokenize("Messages")).toEqual(["message"]);
});

test("sparse index works over docs built from server metadata", () => {
  const servers: ServerEntry[] = [
    {
      name: "demo",
      tools: [
        {
          name: "list_projects",
          description: "List available projects.",
          inputSchema: {
            type: "object",
            properties: {
              status: {
                type: "string",
                description: "Filter by project status",
                enum: ["active", "archived"],
              },
            },
          },
        },
        {
          name: "send_invoice",
          description: "Send an invoice to a customer.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    },
  ];

  const docs = buildDocs(servers);
  const sparseIndex = buildSparseIndex(docs);
  const lazyIndex = buildIndex(docs);

  expect(rankSparse("archived projects", sparseIndex)[0]?.name).toBe(
    "demo.list_projects"
  );
  expect(
    rankSparse("send the customer an invoice", sparseIndex).map((r) => r.name)
  ).toEqual(
    rank("send the customer an invoice", lazyIndex)
      .filter((r) => r.score > 0)
      .map((r) => r.name)
  );
});
