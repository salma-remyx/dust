// Eagerly-scored sparse BM25 index: term weights are computed once at build
// time and stored in an inverted index (term -> postings of pre-computed
// per-document contributions), so a query touches only the posting lists of
// its own terms instead of re-walking every document.
//
// The lazy ranker in bm25.ts rebuilds a term-frequency map for every document
// on every query, i.e. O(n_docs * dl) work per query. Here the build pays that
// cost once — O(corpus) — and each query becomes O(sum of posting lengths for
// the query terms), which is the interesting property when the same corpus is
// scored against hundreds of labeled queries.
//
// Scores are numerically identical to bm25.ts (same k1/b, same idf, same
// tokenizer): the eager index is a drop-in that changes the cost model, not
// the ranking. Adapted from "BM25S: Orders of magnitude faster lexical search
// via eager sparse scoring" (arXiv:2407.03618), which stores the per-term
// scores in scipy sparse matrices; the Map-of-arrays below is the
// plain-TypeScript equivalent.
//
// Tokenizer: lowercase, split on non-alphanumeric, then a crude
// singularization (strip one trailing "s" on tokens longer than 3 chars).
// Product names such as OneDrive / SharePoint / PowerPoint are intentionally
// kept whole so they match how users type them, and singularization
// approximates stemming so doc~docs, file~files, sheet~sheets match. The same
// tokenizer is applied to both the query and the documents.

import {
  type Document,
  type RankedDocument,
  tokenize,
} from "@app/scripts/mcp_bm25/bm25";

const K1 = 1.2;
const B = 0.75;

export interface SparseBm25Index {
  names: string[];
  /** term -> flat [docIndex, weight, docIndex, weight, ...] postings. */
  postings: Map<string, number[]>;
}

export function buildSparseIndex(docs: Document[]): SparseBm25Index {
  const names = docs.map((d) => d.name);
  const tokenized = docs.map((d) => tokenize(d.text));
  const n = docs.length;
  const avgdl = tokenized.reduce((sum, t) => sum + t.length, 0) / n;

  const df = new Map<string, number>();
  for (const toks of tokenized) {
    for (const t of new Set(toks)) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }

  // Eager scoring pass: for each document, compute and store the final BM25
  // contribution of every term it contains, so queries never touch tf/dl again.
  const postings = new Map<string, number[]>();
  tokenized.forEach((docTokens, i) => {
    const tf = new Map<string, number>();
    for (const t of docTokens) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
    }

    const dl = docTokens.length;
    const norm = K1 * (1 - B + B * (dl / avgdl));
    for (const [t, f] of tf) {
      const idf = Math.log(
        1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5)
      );
      const weight = (idf * (f * (K1 + 1))) / (f + norm);
      const posting = postings.get(t);
      if (posting) {
        posting.push(i, weight);
      } else {
        postings.set(t, [i, weight]);
      }
    }
  });

  return { names, postings };
}

export function rankSparse(
  query: string,
  idx: SparseBm25Index
): RankedDocument[] {
  // Accumulate scores directly by document index; only documents sharing a
  // term with the query are ever visited.
  const scores = new Map<number, number>();
  for (const q of new Set(tokenize(query))) {
    const posting = idx.postings.get(q);
    if (!posting) {
      continue;
    }
    for (let p = 0; p < posting.length; p += 2) {
      scores.set(posting[p], (scores.get(posting[p]) ?? 0) + posting[p + 1]);
    }
  }

  return [...scores]
    .map(([i, score]) => ({ name: idx.names[i], score }))
    .sort((a, b) => b.score - a.score);
}
