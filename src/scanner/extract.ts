// Turns ParsedFile[] into a GraphSchema (nodes + edges).
//
// Edges produced in M1:
//   defines : file → symbol
//   imports : file → file (when the import target resolves inside the project)
//   tests   : test-file → source-file (for foo.test.ts ↔ foo.ts)

import { dirname, join, posix } from "node:path";

import type { Edge, FileNode, GraphSchema, SymbolIndex, SymbolNode } from "../graph/types.js";
import { SCHEMA_VERSION } from "../graph/types.js";
import { fileHash } from "./hash.js";
import { extractKeywords } from "./keywords.js";
import type { CallSite, ParsedFile, ParsedSymbol } from "./parser.js";

const RESOLVE_EXTS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".svelte",
  ".vue",
  ".dart",
  ".html",
  ".hubl",
];
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx", "__init__.py"];

function fileId(relPath: string): string {
  return `file:${relPath}`;
}

function symbolId(relPath: string, sym: ParsedSymbol): string {
  return `symbol:${relPath}::${sym.name}:${sym.startLine}`;
}

function toFileNode(parsed: ParsedFile): FileNode {
  const content = parsed.source;
  return {
    id: fileId(parsed.file.relPath),
    kind: "file",
    path: parsed.file.relPath,
    ext: parsed.file.ext,
    size: parsed.file.size,
    keywords: extractKeywords(content, parsed.file.ext),
    content,
    summary: extractSummary(content),
    file_hash: fileHash(content),
  };
}

function extractSummary(content: string): string {
  // First leading comment block (// ... or /** ... */ or # ...), trimmed to ~200 chars.
  const trimmed = content.replace(/^\s+/, "");
  const slashMatch = trimmed.match(/^\/\/\s?(.*(?:\r?\n\/\/\s?.*)*)/);
  if (slashMatch?.[1]) return slashMatch[1].split(/\r?\n/).join(" ").trim().slice(0, 200);
  const blockMatch = trimmed.match(/^\/\*\*?([\s\S]*?)\*\//);
  if (blockMatch?.[1]) {
    return blockMatch[1]
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*\*\s?/, ""))
      .join(" ")
      .trim()
      .slice(0, 200);
  }
  const hashMatch = trimmed.match(/^#\s?(.*(?:\r?\n#\s?.*)*)/);
  if (hashMatch?.[1]) return hashMatch[1].split(/\r?\n/).join(" ").trim().slice(0, 200);
  return "";
}

function toSymbolNode(parsed: ParsedFile, sym: ParsedSymbol): SymbolNode {
  return {
    id: symbolId(parsed.file.relPath, sym),
    kind: "symbol",
    symbol_kind: sym.kind,
    name: sym.name,
    file: parsed.file.relPath,
    start_line: sym.startLine,
    end_line: sym.endLine,
    signature: sym.signature,
  };
}

/**
 * Resolve an import specifier to a project-relative path if it refers to a
 * file inside the project. Returns `null` for external packages (no leading
 * dot) or specifiers that don't match any known file.
 */
// Strip a trailing JS-family extension so a spec like "./crypto.js" can
// resolve to "crypto.ts". TypeScript-style `.js` imports are common.
const REWRITE_EXT_RE = /\.(js|jsx|mjs|cjs)$/;

function resolveImport(
  fromRelPath: string,
  spec: string,
  filesByPath: Map<string, true>,
): string | null {
  if (!spec.startsWith(".")) return null;
  const fromDir = posix.dirname(toPosix(fromRelPath));
  const base = posix.normalize(posix.join(fromDir, toPosix(spec)));

  const candidates = [base];
  const rewritten = base.replace(REWRITE_EXT_RE, "");
  if (rewritten !== base) candidates.push(rewritten);

  for (const c of candidates) {
    if (filesByPath.has(c)) return c;
    for (const ext of RESOLVE_EXTS) {
      if (filesByPath.has(c + ext)) return c + ext;
    }
    for (const idx of INDEX_FILES) {
      const candidate = posix.join(c, idx);
      if (filesByPath.has(candidate)) return candidate;
    }
  }
  return null;
}

function toPosix(p: string): string {
  return p.split(/[\\/]/).join("/");
}

const TEST_RE = /^(?<base>.+?)\.(test|spec)\.(?<ext>[tj]sx?|py)$/;

function testTarget(relPath: string, filesByPath: Map<string, true>): string | null {
  const fileName = relPath.split("/").pop() ?? relPath;
  const match = TEST_RE.exec(fileName);
  if (!match) return null;
  const dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/") + 1) : "";
  const base = match.groups?.base ?? "";
  const ext = match.groups?.ext ?? "";
  if (!base || !ext) return null;
  const candidate = `${dir}${base}.${ext}`;
  if (filesByPath.has(candidate)) return candidate;
  // Try sibling extensions (e.g. foo.test.ts → foo.tsx)
  for (const e of RESOLVE_EXTS) {
    const alt = `${dir}${base}${e}`;
    if (filesByPath.has(alt)) return alt;
  }
  return null;
}

export async function buildGraph(root: string, parsed: ParsedFile[]): Promise<GraphSchema> {
  const filesByPath = new Map<string, true>();
  for (const p of parsed) filesByPath.set(p.file.relPath, true);

  const nodes: (FileNode | SymbolNode)[] = [];
  const edges: Edge[] = [];

  // Collected during the file loop, then resolved into `calls` edges in one pass
  // (callee resolution needs the full symbol set).
  const symbolsByFile = new Map<string, SymbolNode[]>();
  const callsByFile = new Map<string, CallSite[]>();

  for (const p of parsed) {
    const fileNode = toFileNode(p);
    nodes.push(fileNode);

    const fileSymNodes: SymbolNode[] = [];
    for (const sym of p.symbols) {
      const symNode = toSymbolNode(p, sym);
      nodes.push(symNode);
      fileSymNodes.push(symNode);
      edges.push({ from: fileNode.id, to: symNode.id, kind: "defines" });
    }
    symbolsByFile.set(p.file.relPath, fileSymNodes);
    callsByFile.set(p.file.relPath, p.calls);

    const importEdges = new Set<string>();
    for (const spec of p.imports) {
      const target = resolveImport(p.file.relPath, spec, filesByPath);
      if (!target) continue;
      const key = `${fileNode.id}->${fileId(target)}`;
      if (importEdges.has(key)) continue;
      importEdges.add(key);
      edges.push({ from: fileNode.id, to: fileId(target), kind: "imports" });
    }

    const testTargetPath = testTarget(p.file.relPath, filesByPath);
    if (testTargetPath && testTargetPath !== p.file.relPath) {
      edges.push({ from: fileNode.id, to: fileId(testTargetPath), kind: "tests" });
    }
  }

  edges.push(...buildCallEdges(symbolsByFile, callsByFile));

  const symbolCount = nodes.filter((n) => n.kind === "symbol").length;
  const fileCount = nodes.length - symbolCount;

  return {
    root,
    node_count: nodes.length,
    edge_count: edges.length,
    file_count: fileCount,
    symbol_count: symbolCount,
    nodes,
    edges,
    generated_at: new Date().toISOString(),
    schema_version: SCHEMA_VERSION,
  };
}

export function buildSymbolIndex(graph: GraphSchema): SymbolIndex {
  // Null-prototype map: symbol names like "toString" or "constructor" (common
  // in Dart, where every class overrides toString) would otherwise resolve to
  // an inherited Object.prototype member and crash on the .push below.
  const out: SymbolIndex = Object.create(null);
  for (const node of graph.nodes) {
    if (node.kind !== "symbol") continue;
    const list = out[node.name] ?? (out[node.name] = []);
    list.push({ file: node.file, line: node.start_line, kind: node.symbol_kind });
  }
  return out;
}

/** The same-file symbol whose [start_line, end_line] tightest-contains `line`
 *  (smallest span wins, so an inner method beats its enclosing class). null if
 *  the line is outside every symbol (e.g. a module-level call). */
export function tightestContainer(syms: SymbolNode[], line: number): SymbolNode | null {
  let best: SymbolNode | null = null;
  for (const s of syms) {
    if (line < s.start_line || line > s.end_line) continue;
    if (!best || s.end_line - s.start_line < best.end_line - best.start_line) best = s;
  }
  return best;
}

/**
 * Resolve raw call sites into symbol→symbol `calls` edges. Name-based (no type
 * info), precision-first:
 *   - caller = the call site's tightest-containing symbol in the SAME file
 *     (no container, e.g. a top-level call → skipped)
 *   - callee = a same-file symbol of that name, else the UNIQUE repo-wide symbol
 *     of that name; 0 matches (external/builtin) or >1 (ambiguous) → skipped
 * Recursion self-edges and duplicates are dropped.
 */
export function buildCallEdges(
  symbolsByFile: Map<string, SymbolNode[]>,
  callsByFile: Map<string, CallSite[]>,
): Edge[] {
  // Repo-wide name → symbols index, for the cross-file fallback.
  const byName = new Map<string, SymbolNode[]>();
  for (const syms of symbolsByFile.values()) {
    for (const s of syms) {
      const list = byName.get(s.name);
      if (list) list.push(s);
      else byName.set(s.name, [s]);
    }
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();

  for (const [relPath, sites] of callsByFile) {
    const fileSyms = symbolsByFile.get(relPath) ?? [];
    for (const site of sites) {
      const caller = tightestContainer(fileSyms, site.line);
      if (!caller) continue;

      let callee = fileSyms.find((s) => s.name === site.callee);
      if (!callee) {
        const cands = byName.get(site.callee) ?? [];
        if (cands.length !== 1) continue; // 0 = external/builtin, >1 = ambiguous
        callee = cands[0];
      }
      if (!callee || callee.id === caller.id) continue; // skip recursion self-edges

      const key = `${caller.id}->${callee.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: caller.id, to: callee.id, kind: "calls" });
    }
  }
  return edges;
}

// Re-export node path helpers in case downstream wants the canonical id format
export { fileId, symbolId };
// Suppress unused-import lint for dirname/join from node:path — kept reserved for incremental updates.
void dirname;
void join;
