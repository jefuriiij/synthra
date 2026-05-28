// Compresses a list of retrieved files into a structured context pack:
// signatures + top function bodies + tests co-retrieved + dependency edges.
// Budget is enforced in characters (~ tokens × 4) — see SYN_HARD_MAX_READ_CHARS.

import type { FileNode, GraphSchema, SymbolNode } from "../graph/types.js";
import { formatPack, type FormatFileSection } from "./format.js";
import { selectInlineBodies } from "./inline.js";
import { extractSignatures } from "./signatures.js";
import { findTestsForFile } from "./tests.js";

export interface PackOptions {
  query: string;
  graph: GraphSchema;
  /** Soft target for total tokens (≈ chars/4). Default: 4000. */
  budgetTokens?: number;
  /** Fraction of remaining budget to spend on a single file's inline bodies. Default: 0.5. */
  inlineBodyRatio?: number;
  /** Co-retrieve linked test files when packing source files. Default: true. */
  includeTests?: boolean;
  /** Optional: file path → reason string from the ranker, surfaced in the pack heading. */
  reasons?: Map<string, string>;
}

export interface ContextPack {
  text: string;
  tokenEstimate: number;
  filesUsed: string[];
  testsCoRetrieved: string[];
  truncated: boolean;
}

const STATIC_OVERHEAD_PER_FILE = 200; // headers + bullet markdown + spacing
const MAX_INLINE_CHARS_PER_FILE = 2500;

function indexSymbolsByFile(graph: GraphSchema): SymbolNode[] {
  return graph.nodes.filter((n): n is SymbolNode => n.kind === "symbol");
}

export async function pack(files: FileNode[], opts: PackOptions): Promise<ContextPack> {
  const budgetTokens = opts.budgetTokens ?? 4000;
  const budgetChars = budgetTokens * 4;
  const inlineRatio = opts.inlineBodyRatio ?? 0.5;
  const includeTests = opts.includeTests ?? true;
  const reasons = opts.reasons ?? new Map<string, string>();

  const symbols = indexSymbolsByFile(opts.graph);

  const sections: FormatFileSection[] = [];
  const testsCoRetrieved: string[] = [];
  let used = 0;
  let truncated = false;

  for (const file of files) {
    const sig = extractSignatures(file, symbols);
    const testFiles = includeTests ? findTestsForFile(opts.graph, file) : [];
    const testPaths = testFiles.map((t) => t.path);

    const staticCost =
      file.path.length +
      sig.join("\n").length +
      testPaths.join(",").length +
      STATIC_OVERHEAD_PER_FILE;

    if (used + staticCost > budgetChars) {
      truncated = true;
      break;
    }

    const remaining = budgetChars - used - staticCost;
    const inlineBudget = Math.min(Math.floor(remaining * inlineRatio), MAX_INLINE_CHARS_PER_FILE);

    const inline = selectInlineBodies(file, symbols, opts.query, inlineBudget);

    sections.push({
      path: file.path,
      reason: reasons.get(file.path),
      signatures: sig,
      inlineBodies: inline.text,
      associatedTests: testPaths,
    });

    used += staticCost + inline.charsUsed;
    for (const t of testPaths) if (!testsCoRetrieved.includes(t)) testsCoRetrieved.push(t);

    if (used >= budgetChars) {
      truncated = true;
      break;
    }
  }

  if (sections.length < files.length) truncated = true;

  const text = formatPack({
    query: opts.query,
    files: sections,
    truncated,
  });
  const tokenEstimate = Math.ceil(text.length / 4);

  return {
    text,
    tokenEstimate,
    filesUsed: sections.map((s) => s.path),
    testsCoRetrieved,
    truncated,
  };
}
