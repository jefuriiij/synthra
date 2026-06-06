// Scoring for retrieved files. Combines:
//   - keyword overlap with the (already-tokenized) query
//   - symbol-name overlap (boosted: hits in a file's defined symbols matter more)
//   - import-graph proximity from session-known + recent paths (boost adjacent files)
//   - recency boost from activity log (placeholder — wired in M5)

import type { Edge, FileNode, GraphSchema, SymbolNode } from "./types.js";

export interface RankInputs {
  candidates: FileNode[];
  query: string;
  graph?: GraphSchema;
  recentlyEditedPaths?: string[];
  sessionKnownPaths?: string[];
  /** Decayed per-file usage weights (path → weight) from the learning layer.
   *  Applied as a bounded boost to files that ALREADY match the query. Omit to
   *  disable (the ranker is then byte-identical to its deterministic form). */
  usageScores?: ReadonlyMap<string, number>;
}

// Max additive usage boost. Strictly below the +5 seed boost so a maxed-out
// usage signal can reorder within a relevance band but never leapfrog a freshly
// seeded file or two exact symbol matches (+6). Env-overridable for tuning.
const USAGE_BOOST_CAP_DEFAULT = 4;

function usageBoostCap(): number {
  const env = Number(process.env.SYN_LEARN_BOOST_CAP);
  return Number.isFinite(env) && env >= 0 ? env : USAGE_BOOST_CAP_DEFAULT;
}

export interface ScoredFile {
  file: FileNode;
  score: number;
  reasons: string[];
  /** Total symbol-match weight (exact name = 3, partial substring = 1). */
  symHits: number;
  /** Count of symbols whose name a query token matched *exactly*. The gate
   *  uses this — a partial substring match is too noisy ("id" ⊂ "width"). */
  exactSym: number;
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "have",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "we",
  "with",
  "what",
  "where",
  "when",
  "why",
  "how",
  "do",
  "does",
  "i",
  "me",
  "my",
  "you",
  "your",
  "code",
  "file",
]);

export function tokenizeQuery(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  // Also split camelCase/snake_case for queries like "AuthService"
  const expanded = new Set<string>();
  for (const t of tokens) {
    expanded.add(t);
    const parts = t.match(/[a-z]+|[0-9]+/g) ?? [];
    for (const p of parts) if (p.length > 1) expanded.add(p);
  }
  return Array.from(expanded);
}

function indexSymbolsByFile(graph: GraphSchema | undefined): Map<string, SymbolNode[]> {
  const out = new Map<string, SymbolNode[]>();
  if (!graph) return out;
  for (const n of graph.nodes) {
    if (n.kind !== "symbol") continue;
    const list = out.get(n.file) ?? [];
    list.push(n);
    out.set(n.file, list);
  }
  return out;
}

function indexImportEdges(graph: GraphSchema | undefined): Map<string, Set<string>> {
  // file path → set of file paths it imports (1-hop)
  const out = new Map<string, Set<string>>();
  if (!graph) return out;
  const idToPath = new Map<string, string>();
  for (const n of graph.nodes) if (n.kind === "file") idToPath.set(n.id, n.path);
  for (const e of graph.edges as Edge[]) {
    if (e.kind !== "imports") continue;
    const from = idToPath.get(e.from);
    const to = idToPath.get(e.to);
    if (!from || !to) continue;
    const s = out.get(from) ?? new Set<string>();
    s.add(to);
    out.set(from, s);
  }
  return out;
}

export function scoreFiles(inputs: RankInputs): ScoredFile[] {
  const qTokens = new Set(tokenizeQuery(inputs.query));
  const symbolsByFile = indexSymbolsByFile(inputs.graph);
  const importsFrom = indexImportEdges(inputs.graph);

  const seeds = new Set<string>(inputs.sessionKnownPaths ?? []);
  for (const p of inputs.recentlyEditedPaths ?? []) seeds.add(p);

  // First pass: keyword + symbol score
  const scored: ScoredFile[] = [];
  for (const file of inputs.candidates) {
    const reasons: string[] = [];
    let score = 0;

    // Keyword overlap
    let kwHits = 0;
    for (const kw of file.keywords) if (qTokens.has(kw)) kwHits += 1;
    if (kwHits) {
      score += kwHits * 2;
      reasons.push(`kw=${kwHits}`);
    }

    // Symbol-name overlap (higher signal than file-level keywords)
    const symbols = symbolsByFile.get(file.path) ?? [];
    let symHits = 0;
    let exactSym = 0;
    for (const sym of symbols) {
      const name = sym.name.toLowerCase();
      if (qTokens.has(name)) {
        symHits += 3;
        exactSym += 1;
      } else {
        // partial match: any query token is a substring of, or contained by, the symbol name
        for (const t of qTokens) {
          if (name.includes(t) || t.includes(name)) {
            symHits += 1;
            break;
          }
        }
      }
    }
    if (symHits) {
      score += symHits;
      reasons.push(`sym=${symHits}`);
    }

    // Path match: file path contains a query token
    const pathLower = file.path.toLowerCase();
    let pathHits = 0;
    for (const t of qTokens) if (pathLower.includes(t)) pathHits += 1;
    if (pathHits) {
      score += pathHits;
      reasons.push(`path=${pathHits}`);
    }

    if (seeds.has(file.path)) {
      score += 5;
      reasons.push("seed");
    }

    scored.push({ file, score, reasons, symHits, exactSym });
  }

  // Second pass: 1-hop import-graph boost from any file already scored > 0
  const positivePaths = new Set(scored.filter((s) => s.score > 0).map((s) => s.file.path));
  if (positivePaths.size > 0) {
    for (const s of scored) {
      if (s.score > 0) continue;
      // Does any file that imports this one have a positive score?
      let importBoost = 0;
      for (const [from, tos] of importsFrom) {
        if (!positivePaths.has(from)) continue;
        if (tos.has(s.file.path)) {
          importBoost += 1;
          break;
        }
      }
      if (importBoost) {
        s.score += importBoost * 0.5;
        s.reasons.push("imp-adj");
      }
    }
  }

  // Usage-learning boost (learning v1): files the session has actually pulled or
  // edited get a small, decayed, capped bump so genuinely-hot files surface
  // first. Anchored to files that already match the query (score > 0) so a
  // popular-but-irrelevant file is never promoted; relatively normalized (u/maxU)
  // and capped below the +5 seed so it reorders within a band, never dominates.
  const usage = inputs.usageScores;
  if (usage && usage.size > 0) {
    let maxU = 0;
    for (const v of usage.values()) if (v > maxU) maxU = v;
    if (maxU > 0) {
      const cap = usageBoostCap();
      for (const s of scored) {
        if (s.score <= 0) continue;
        const u = usage.get(s.file.path) ?? 0;
        if (u <= 0) continue;
        s.score += cap * (u / maxU);
        s.reasons.push(`used×${Math.round(u)}`);
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

export function rank(inputs: RankInputs): FileNode[] {
  return scoreFiles(inputs).map((s) => s.file);
}
