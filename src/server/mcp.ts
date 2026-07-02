// MCP-over-HTTP (streamable) protocol handler. Exposes Synthra's graph tools
// to Claude Code via JSON-RPC 2.0 messages POSTed to /mcp.
//
// Tools:
//   graph_continue(query)            — retrieve + pack a context bundle
//   graph_read(target)               — return source for "file" or "file::symbol"
//   graph_register_edit(files)       — Claude tells Synthra it edited files
//
// Spec: https://modelcontextprotocol.io/specification

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { tokenizeQuery } from "../graph/rank.js";
import { retrieve } from "../graph/retrieve.js";
import type { FileNode, GraphSchema, SymbolNode } from "../graph/types.js";
import { appendAccess } from "../learn/store.js";
import type { AccessEvent } from "../learn/usage.js";
import { recallEntries, rememberEntry } from "../memory/index.js";
import type { ContextEntry, EntryAnchor, EntryKind } from "../memory/context-store.js";
import { pack } from "../packer/index.js";
import { findTestsForFile } from "../packer/tests.js";
import { loadConfig } from "../shared/config.js";
import type { ServerContext } from "./context.js";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "synthra", version: "0.0.1" } as const;

type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function err(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

function textContent(text: string) {
  return { content: [{ type: "text", text }], isError: false };
}

function errorContent(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}

const TOOLS = [
  {
    name: "graph_continue",
    description:
      "Returns the project context most relevant to a query — function signatures, top function bodies, and linked test files. Use this BEFORE Grep/Glob. If `confidence` is 'high', do not call Grep/Glob for the same query.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language description of what you're looking for.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "graph_read",
    description:
      "Return the source code for a specific file or symbol. Target is either a project-relative file path (e.g. 'src/auth.ts') or 'file::symbol' (e.g. 'src/auth.ts::AuthService'). A symbol read also returns its dependency surface — the signatures of the symbols it calls (edit against these instead of guessing or re-reading their files) and the names of the symbols that call it.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "File path or file::symbol notation." },
      },
      required: ["target"],
    },
  },
  {
    name: "graph_register_edit",
    description:
      "Tell Synthra that you (the AI) have edited these files. Lets Synthra rank them higher in subsequent retrieval and avoid surfacing stale context.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "Project-relative file paths that were edited.",
        },
      },
      required: ["files"],
    },
  },
  {
    name: "context_remember",
    description:
      "Persist a decision/task/next-step/fact/blocker into the project's branch-aware context store. Use when the user makes a decision worth keeping, identifies a TODO, or surfaces a key fact. Entries land in `.synthra/context-store.json` on the default branch, or `.synthra/branches/<sanitized>/context-store.json` on a feature branch — git-tracked, so teammates inherit them and they merge naturally.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The thing to remember (1–3 sentences)." },
        kind: {
          type: "string",
          enum: ["decision", "task", "next", "fact", "blocker"],
          description: "What kind of entry. Required.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for grouping (e.g. 'auth', 'perf').",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional project-relative file paths this entry relates to. Linked files also anchor the entry: recall flags it 'possibly stale' if they change, and graph_read of those files surfaces it automatically.",
        },
      },
      required: ["text", "kind"],
    },
  },
  {
    name: "context_recall",
    description:
      "Read previously-stored decisions/tasks/facts from the project's branch-aware context store. Defaults to the current branch.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["decision", "task", "next", "fact", "blocker"],
          description: "Filter to a single kind.",
        },
        branch: { type: "string", description: "Override which branch to read from." },
        limit: { type: "number", description: "Return only the most recent N entries." },
      },
    },
  },
  {
    name: "recent_activity",
    description:
      "What has the human been doing in the editor recently — file saves, branch switches, and uncommitted-diff changes. Use this to check whether the static context pack may be stale (e.g. before answering a question about a file that was just edited).",
    inputSchema: {
      type: "object",
      properties: {
        since_ms: {
          type: "number",
          description:
            "Epoch milliseconds. Only return events newer than this. Defaults to the last 60 minutes.",
        },
        limit: { type: "number", description: "Cap on returned events." },
      },
    },
  },
  {
    name: "count_tokens",
    description:
      "Estimate token count for a piece of text using a char/4 approximation. Accurate within ~10% for English + code. Useful for budgeting prompt content before sending.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to estimate tokens for." },
      },
      required: ["text"],
    },
  },
  {
    name: "blast_radius",
    description:
      "See what could break before an edit. A bare file target returns all files that depend on it transitively via imports, tests, and call edges. A 'file::symbol' target returns the exact caller SYMBOLS that transitively call it (name → file:line) plus the test files guarding the impact — the precise rename-safety view. Call edges are name-resolved (precise within a file, unique-name across files).",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "File path (file-level dependents) or 'file::symbol' (caller symbols).",
        },
        depth: { type: "number", description: "Max hops to traverse. Default 3." },
      },
      required: ["target"],
    },
  },
  {
    name: "dead_code",
    description:
      "Return files in the project that no other file imports and no test file references — strong candidates for unused/orphaned code. File-level granularity; symbol-level dead code (unused exports, on top of the call graph) is a planned follow-up. Common entry-point patterns (main, index, app, CLI, bin/) are excluded heuristically.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Cap on returned files. Default 50." },
      },
    },
  },
  {
    name: "find_symbol",
    description:
      "Find existing symbols by name BEFORE writing a new one — reuse beats re-implementing. Returns exact-name definitions (signatures + graph_read targets) or, if none, similarly-named symbols. 'No symbol matching … — safe to create' means it's genuinely new.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Symbol name (or near-name) to look for." },
      },
      required: ["name"],
    },
  },
  {
    name: "duplicate_symbols",
    description:
      "List symbol names defined in more than one file (functions/classes/types; methods excluded) — consolidation candidates for review. Advisory: duplicates may be intentional.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Cap on returned names. Default 30." },
      },
    },
  },
  {
    name: "call_path",
    description:
      "Trace how one symbol reaches another through the call graph — the shortest chain of calls from 'from' to 'to'. Use to understand control flow ('how does this handler end up hitting the DB layer?'). Each of 'from'/'to' is a 'file::symbol' target or a bare symbol name when unique.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Starting symbol ('file::symbol' or unique name)." },
        to: { type: "string", description: "Target symbol ('file::symbol' or unique name)." },
        depth: { type: "number", description: "Max call hops to search. Default 6." },
      },
      required: ["from", "to"],
    },
  },
] as const;

async function callTool(
  name: string,
  args: Record<string, unknown> | undefined,
  ctx: ServerContext,
) {
  switch (name) {
    case "graph_continue":
      return graphContinue(args, ctx);
    case "graph_read":
      return graphRead(args, ctx);
    case "graph_register_edit":
      return graphRegisterEdit(args, ctx);
    case "context_remember":
      return contextRemember(args, ctx);
    case "context_recall":
      return contextRecall(args, ctx);
    case "recent_activity":
      return recentActivity(args, ctx);
    case "count_tokens":
      return countTokens(args);
    case "blast_radius":
      return blastRadius(args, ctx);
    case "dead_code":
      return deadCode(args, ctx);
    case "find_symbol":
      return findSymbol(args, ctx);
    case "duplicate_symbols":
      return duplicateSymbols(args, ctx);
    case "call_path":
      return callPath(args, ctx);
    default:
      return errorContent(`Unknown tool: ${name}`);
  }
}

function countTokens(args: Record<string, unknown> | undefined) {
  const text = typeof args?.text === "string" ? args.text : "";
  if (!text) return errorContent("count_tokens: 'text' (string) is required");
  const tokens = Math.ceil(text.length / 4);
  return textContent(JSON.stringify({ tokens, method: "chars/4 estimate", chars: text.length }));
}

function blastRadius(args: Record<string, unknown> | undefined, ctx: ServerContext) {
  const targetRaw = typeof args?.target === "string" ? args.target.trim() : "";
  const maxDepth = typeof args?.depth === "number" && args.depth > 0 ? Math.floor(args.depth) : 3;
  if (!targetRaw) return errorContent("blast_radius: 'target' (string) is required");

  // A `file::symbol` target → precise caller-symbol impact (for renames). A bare
  // file → the file-level dependent view below (unchanged).
  if (targetRaw.includes("::")) return blastRadiusSymbol(targetRaw, maxDepth, ctx);

  const filePath = targetRaw;
  const root = ctx.graph.nodes.find((n): n is FileNode => n.kind === "file" && n.path === filePath);
  if (!root) return errorContent(`blast_radius: file not in graph: ${filePath}`);

  // Index reverse edges (to → [{from, kind}]) once per call. `calls` edges are
  // symbol→symbol, so project them to file level (a caller's file depends on the
  // callee's file), skipping intra-file calls.
  const fileIdBySymbol = new Map<string, string>();
  for (const n of ctx.graph.nodes) {
    if (n.kind === "symbol") fileIdBySymbol.set(n.id, `file:${n.file}`);
  }
  const incoming = new Map<string, Array<{ from: string; kind: string }>>();
  const addIncoming = (to: string, from: string, kind: string): void => {
    const list = incoming.get(to) ?? [];
    list.push({ from, kind });
    incoming.set(to, list);
  };
  for (const e of ctx.graph.edges) {
    if (e.kind === "imports" || e.kind === "tests") {
      addIncoming(e.to, e.from, e.kind);
    } else if (e.kind === "calls") {
      const fromFile = fileIdBySymbol.get(e.from);
      const toFile = fileIdBySymbol.get(e.to);
      if (fromFile && toFile && fromFile !== toFile) addIncoming(toFile, fromFile, "calls");
    }
  }

  interface Hit {
    path: string;
    depth: number;
    via: string;
  }

  const visited = new Set<string>([root.id]);
  const hits: Hit[] = [];
  const pathById = new Map<string, string>();
  for (const n of ctx.graph.nodes) if (n.kind === "file") pathById.set(n.id, n.path);

  let frontier = [root.id];
  for (let d = 1; d <= maxDepth; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      const callers = incoming.get(cur) ?? [];
      for (const c of callers) {
        if (visited.has(c.from)) continue;
        visited.add(c.from);
        next.push(c.from);
        const path = pathById.get(c.from) ?? c.from;
        hits.push({ path, depth: d, via: c.kind });
      }
    }
    frontier = next;
    if (next.length === 0) break;
  }

  if (hits.length === 0) {
    return textContent(`# Blast radius for ${filePath}\n\n_(no dependents — file is isolated)_`);
  }

  hits.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
  const lines = [`# Blast radius for ${filePath}  (depth ≤ ${maxDepth})`, ""];
  lines.push(`${hits.length} dependent file(s):`);
  for (const h of hits) {
    lines.push(`- **depth ${h.depth}** \`${h.path}\` _(via ${h.via})_`);
  }
  return textContent(lines.join("\n"));
}

// Symbol-level blast radius: which symbols transitively CALL the target symbol.
// This is the rename-safety view — exact caller symbols + locations, not the
// file-level rollup. (`graph_read`'s "Used by (N)" footer covers the cheap
// always-on direct-caller case; this is the complete, transitive, on-demand one.)
function blastRadiusSymbol(targetRaw: string, maxDepth: number, ctx: ServerContext) {
  const [rawFile, rawSym] = targetRaw.split("::", 2);
  const filePath = (rawFile ?? "").trim();
  const symName = (rawSym ?? "").trim();
  if (!symName) return errorContent("blast_radius: 'file::symbol' target needs a symbol name");

  const resolved = resolveFileTarget(ctx.graph, filePath);
  if ("ambiguous" in resolved) {
    const shown = resolved.ambiguous.slice(0, 5).join(", ");
    return errorContent(
      `blast_radius: '${filePath}' matches multiple files (${shown}). Pass a longer path.`,
    );
  }
  if ("none" in resolved) return errorContent(`blast_radius: file not in graph: ${filePath}`);
  const fileNode = resolved.node;

  const symbol = ctx.graph.nodes.find(
    (n): n is SymbolNode => n.kind === "symbol" && n.file === fileNode.path && n.name === symName,
  );
  if (!symbol)
    return errorContent(`blast_radius: symbol '${symName}' not found in ${fileNode.path}`);

  // Reverse call map (callee-id → caller-ids) + symbol lookup, built once.
  const callersBySym = new Map<string, string[]>();
  for (const e of ctx.graph.edges) {
    if (e.kind !== "calls" || e.from === e.to) continue;
    const list = callersBySym.get(e.to) ?? [];
    list.push(e.from);
    callersBySym.set(e.to, list);
  }
  const symById = new Map<string, SymbolNode>();
  for (const n of ctx.graph.nodes) if (n.kind === "symbol") symById.set(n.id, n);

  interface Hit {
    name: string;
    file: string;
    line: number;
    depth: number;
  }
  const visited = new Set<string>([symbol.id]);
  const hits: Hit[] = [];
  let frontier = [symbol.id];
  for (let d = 1; d <= maxDepth; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const fromId of callersBySym.get(cur) ?? []) {
        if (visited.has(fromId)) continue;
        visited.add(fromId);
        next.push(fromId);
        const s = symById.get(fromId);
        if (s) hits.push({ name: s.name, file: s.file, line: s.start_line, depth: d });
      }
    }
    frontier = next;
    if (next.length === 0) break;
  }

  const header = `# Blast radius for ${fileNode.path}::${symbol.name}  (callers, depth ≤ ${maxDepth})`;
  if (hits.length === 0) {
    const tline = testsCoveringLine(ctx.graph, [fileNode.path]);
    return textContent(
      `${header}\n\n_(no callers — safe to rename)_${tline ? `\n\n${tline}` : ""}`,
    );
  }
  hits.sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file) || a.line - b.line);
  const lines = [header, "", `${hits.length} caller symbol(s):`];
  for (const h of hits) lines.push(`- **depth ${h.depth}** \`${h.name}\` → ${h.file}:${h.line}`);
  const tline = testsCoveringLine(ctx.graph, [fileNode.path, ...hits.map((h) => h.file)]);
  if (tline) {
    lines.push("");
    lines.push(tline);
  }
  return textContent(lines.join("\n"));
}

// One-line summary of the test files covering a set of source files (deduped).
// Reused by the symbol-level blast radius to show which tests guard a rename.
function testsCoveringLine(graph: GraphSchema, filePaths: string[]): string {
  const fileByPath = new Map<string, FileNode>();
  for (const n of graph.nodes) if (n.kind === "file") fileByPath.set(n.path, n);
  const seen = new Set<string>();
  const tests: string[] = [];
  for (const p of new Set(filePaths)) {
    const fn = fileByPath.get(p);
    if (!fn) continue;
    for (const t of findTestsForFile(graph, fn)) {
      if (!seen.has(t.path)) {
        seen.add(t.path);
        tests.push(t.path);
      }
    }
  }
  if (tests.length === 0) return "";
  const shown = tests.slice(0, TESTS_MAX_FILES);
  const omitted = tests.length - shown.length;
  return `Tests covering the impact: ${shown.join(" · ")}${omitted > 0 ? ` …+${omitted} more` : ""}`;
}

// Resolve a call_path argument to a single symbol: "file::symbol", or a bare
// name when it's unique repo-wide. Returns null on miss/ambiguity.
function resolveSymbolArg(ctx: ServerContext, arg: string): SymbolNode | null {
  const a = arg.trim();
  if (a.includes("::")) {
    const [rawFile, rawSym] = a.split("::", 2);
    const resolved = resolveFileTarget(ctx.graph, (rawFile ?? "").trim());
    if (!("node" in resolved)) return null;
    const name = (rawSym ?? "").trim();
    return (
      ctx.graph.nodes.find(
        (n): n is SymbolNode =>
          n.kind === "symbol" && n.file === resolved.node.path && n.name === name,
      ) ?? null
    );
  }
  const matches = ctx.graph.nodes.filter(
    (n): n is SymbolNode => n.kind === "symbol" && n.name === a,
  );
  return matches.length === 1 ? (matches[0] as SymbolNode) : null;
}

// call_path — forward BFS over `calls` edges from `from` to `to`, reporting the
// shortest call chain. The forward dual of blast_radius (which walks callers).
function callPath(args: Record<string, unknown> | undefined, ctx: ServerContext) {
  const fromArg = typeof args?.from === "string" ? args.from : "";
  const toArg = typeof args?.to === "string" ? args.to : "";
  const maxDepth = typeof args?.depth === "number" && args.depth > 0 ? Math.floor(args.depth) : 6;
  if (!fromArg.trim() || !toArg.trim()) {
    return errorContent("call_path: 'from' and 'to' (strings) are required");
  }

  const from = resolveSymbolArg(ctx, fromArg);
  if (!from) {
    return errorContent(
      `call_path: could not resolve 'from': ${fromArg} (use file::symbol if the name is ambiguous)`,
    );
  }
  const to = resolveSymbolArg(ctx, toArg);
  if (!to) {
    return errorContent(
      `call_path: could not resolve 'to': ${toArg} (use file::symbol if the name is ambiguous)`,
    );
  }
  if (from.id === to.id) {
    return textContent(`# call_path\n\n\`${from.name}\` and \`${to.name}\` are the same symbol.`);
  }

  const calleesBy = new Map<string, string[]>();
  for (const e of ctx.graph.edges) {
    if (e.kind !== "calls" || e.from === e.to) continue;
    (calleesBy.get(e.from) ?? calleesBy.set(e.from, []).get(e.from)!).push(e.to);
  }
  const symById = new Map<string, SymbolNode>();
  for (const n of ctx.graph.nodes) if (n.kind === "symbol") symById.set(n.id, n);

  const prevOf = new Map<string, string>();
  const visited = new Set<string>([from.id]);
  let frontier = [from.id];
  let found = false;
  for (let d = 0; d < maxDepth && !found && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const nb of calleesBy.get(cur) ?? []) {
        if (visited.has(nb)) continue;
        visited.add(nb);
        prevOf.set(nb, cur);
        if (nb === to.id) {
          found = true;
          break;
        }
        next.push(nb);
      }
      if (found) break;
    }
    frontier = next;
  }

  if (!found) {
    return textContent(
      `# call_path: ${from.name} → ${to.name}\n\n_(no call path found within depth ${maxDepth})_`,
    );
  }

  const chain: string[] = [];
  let cur: string | undefined = to.id;
  while (cur !== undefined) {
    chain.unshift(cur);
    if (cur === from.id) break;
    cur = prevOf.get(cur);
  }
  const syms = chain.map((id) => symById.get(id)).filter((s): s is SymbolNode => !!s);
  const hops = syms.length - 1;
  const rendered = syms.map((s) => `\`${s.name}\` (${s.file}:${s.start_line})`).join("\n  → ");
  return textContent(
    `# call_path: ${from.name} → ${to.name}  (${hops} hop${hops === 1 ? "" : "s"})\n\n${rendered}`,
  );
}

const LIKELY_ENTRY_PATTERNS = [
  /(?:^|\/)main\.[a-z0-9_]+$/i,
  /(?:^|\/)index\.[a-z0-9_]+$/i,
  /(?:^|\/)app\.[a-z0-9_]+$/i,
  /(?:^|\/)entry\.[a-z0-9_]+$/i,
  /(?:^|\/)cli[/.]/i,
  /(?:^|\/)bin[/.]/i,
  /(?:^|\/)server\.[a-z0-9_]+$/i,
  /\.test\.[a-z0-9_]+$/i,
  /\.spec\.[a-z0-9_]+$/i,
  /(?:^|\/)tests?\//i,
  /(?:^|\/)__tests__\//i,
  /(?:^|\/)__init__\.py$/i,
];

function isLikelyEntry(path: string): boolean {
  return LIKELY_ENTRY_PATTERNS.some((re) => re.test(path));
}

function deadCode(args: Record<string, unknown> | undefined, ctx: ServerContext) {
  const limit = typeof args?.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 50;

  const hasIncoming = new Set<string>();
  for (const e of ctx.graph.edges) {
    if (e.kind === "imports" || e.kind === "tests") hasIncoming.add(e.to);
  }

  const candidates = ctx.graph.nodes
    .filter((n): n is FileNode => n.kind === "file")
    .filter((f) => !hasIncoming.has(f.id))
    .filter((f) => !isLikelyEntry(f.path));

  if (candidates.length === 0) {
    return textContent(
      `# Dead code\n\n_(no file is unreferenced — every file is either imported by another, has a linked test, or matches an entry-point pattern)_`,
    );
  }

  candidates.sort((a, b) => a.path.localeCompare(b.path));
  const shown = candidates.slice(0, limit);
  const lines = [`# Dead code candidates  (file-level, v0.1)`, ""];
  lines.push(
    `${shown.length} of ${candidates.length} unreferenced file(s) — no other file imports them and no test links them:`,
  );
  lines.push("");
  for (const f of shown) {
    lines.push(`- \`${f.path}\``);
  }
  lines.push("");
  lines.push(
    `_caveat:_ this is file-level only. Symbol-level dead code (unused exports), built on the now-populated call graph, is a planned follow-up.`,
  );
  return textContent(lines.join("\n"));
}

const FIND_MAX = 12;
const FIND_SIG_MAX = 140;

function symbolEntry(s: SymbolNode): string {
  const sig = s.signature.trim().slice(0, FIND_SIG_MAX);
  return `• ${sig}   → mcp__synthra__graph_read("${s.file}::${s.name}")  [${s.symbol_kind}, L${s.start_line}]`;
}

const byFileLine = (a: SymbolNode, b: SymbolNode): number =>
  a.file === b.file ? a.start_line - b.start_line : a.file < b.file ? -1 : 1;

// find_symbol — reuse-first discovery. Exact name matches win; otherwise fall
// back to substring/token-overlap so a near-name still surfaces an existing impl
// to reuse instead of writing a duplicate. "No match" is the green light to create.
function findSymbol(args: Record<string, unknown> | undefined, ctx: ServerContext) {
  const name = typeof args?.name === "string" ? args.name.trim() : "";
  if (!name) return errorContent("find_symbol: 'name' (string) is required");

  const symbols = ctx.graph.nodes.filter((n): n is SymbolNode => n.kind === "symbol");
  const lower = name.toLowerCase();

  const exact = symbols.filter((s) => s.name === name);
  const exactHits =
    exact.length > 0 ? exact : symbols.filter((s) => s.name.toLowerCase() === lower);

  if (exactHits.length > 0) {
    const sorted = exactHits.slice().sort(byFileLine);
    const shown = sorted.slice(0, FIND_MAX);
    const omitted = sorted.length - shown.length;
    const lines = [
      `# find_symbol: "${name}"`,
      "",
      `Exact matches (${sorted.length}) — reuse one of these instead of writing a new one:`,
      ...shown.map(symbolEntry),
    ];
    if (omitted > 0) lines.push(`…+${omitted} more`);
    return textContent(lines.join("\n"));
  }

  const tokens = new Set(tokenizeQuery(name));
  const scored = symbols
    .map((s) => {
      const n = s.name.toLowerCase();
      let score = 0;
      if (n.includes(lower) || lower.includes(n)) score += 2;
      for (const t of tokens) if (n.includes(t)) score += 1;
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || byFileLine(a.s, b.s));

  if (scored.length === 0) {
    return textContent(
      `# find_symbol: "${name}"\n\nNo symbol matching "${name}" — safe to create.`,
    );
  }
  const shown = scored.slice(0, FIND_MAX);
  const omitted = scored.length - shown.length;
  const lines = [
    `# find_symbol: "${name}"`,
    "",
    `No exact match. Similar names (${scored.length}) — reuse or extend one before writing new:`,
    ...shown.map((x) => symbolEntry(x.s)),
  ];
  if (omitted > 0) lines.push(`…+${omitted} more`);
  return textContent(lines.join("\n"));
}

// Symbol kinds worth flagging as cross-file duplicates. Methods are excluded —
// the same method name across different classes is normal, not redundancy.
const DUP_INCLUDE = new Set([
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "const",
  "component",
]);

// duplicate_symbols — advisory consolidation candidates: names defined in ≥2
// distinct files. The only over-engineering check the current graph supports
// cleanly (name lookup); never a "delete this" verdict.
function duplicateSymbols(args: Record<string, unknown> | undefined, ctx: ServerContext) {
  const limit = typeof args?.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 30;

  const defsByName = new Map<string, Array<{ file: string; line: number }>>();
  const filesByName = new Map<string, Set<string>>();
  for (const n of ctx.graph.nodes) {
    if (n.kind !== "symbol" || !DUP_INCLUDE.has(n.symbol_kind)) continue;
    (defsByName.get(n.name) ?? defsByName.set(n.name, []).get(n.name)!).push({
      file: n.file,
      line: n.start_line,
    });
    (filesByName.get(n.name) ?? filesByName.set(n.name, new Set()).get(n.name)!).add(n.file);
  }

  const dups = [...defsByName.entries()]
    .filter(([name]) => (filesByName.get(name)?.size ?? 0) >= 2)
    .map(([name, defs]) => ({
      name,
      defs: defs
        .slice()
        .sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1)),
    }))
    .sort((a, b) => b.defs.length - a.defs.length || a.name.localeCompare(b.name));

  if (dups.length === 0) {
    return textContent(
      "# Duplicate symbols\n\n_(no top-level symbol name is defined in more than one file)_",
    );
  }

  const shown = dups.slice(0, limit);
  const lines = [
    "# Duplicate symbols  (consolidation candidates)",
    "",
    `${shown.length} of ${dups.length} name(s) defined in multiple files (functions/classes/types; methods excluded):`,
    "",
  ];
  for (const d of shown) {
    lines.push(
      `- \`${d.name}\` (${d.defs.length}): ${d.defs.map((x) => `${x.file}:${x.line}`).join(" · ")}`,
    );
  }
  lines.push("");
  lines.push(
    "_advisory: the same name in multiple files may be intentional — verify before consolidating._",
  );
  return textContent(lines.join("\n"));
}

async function graphContinue(args: Record<string, unknown> | undefined, ctx: ServerContext) {
  const query = typeof args?.query === "string" ? args.query : "";
  if (!query) return errorContent("graph_continue: 'query' (string) is required");

  // Session-aware routing (#14): seed retrieval with files the session has
  // touched — the human's recent saves + edits the AI registered via
  // graph_register_edit — so the ranker boosts them. Mirrors the /pack route.
  const retrieval = await retrieve(ctx.graph, query, {
    recentlyEditedPaths: ctx.activity.recentFilePaths(15 * 60 * 1000),
    sessionKnownPaths: getRegisteredEdits(),
    usageScores: ctx.learn?.effectiveScores(),
  });
  const packed = await pack(retrieval.files, { query, graph: ctx.graph });

  // Log the query (no file, weight 0) as query→outcome fuel for a future
  // mechanism — never count retrieval.files, which would feed ranking its own
  // output and cause popularity runaway.
  await logAccess(ctx, { ts: nowIso(), path: "", source: "continue", query });

  const header =
    `Confidence: ${retrieval.confidence}\n` +
    `Files: ${retrieval.files.map((f) => f.path).join(", ") || "(none)"}\n` +
    `Reason: ${retrieval.reason}\n`;

  // Recall half of the second brain: fold the top query-relevant remembered
  // entries into the pack header (a couple of lines, no pack-budget impact),
  // so stored decisions/gotchas resurface exactly when their topic comes up.
  const remembered = matchRememberedFacts(query, retrieval.files, await safeRecallAll(ctx), ctx);

  // The pack body already starts with a header — keep them concatenated.
  return textContent(`${header}${remembered}\n${packed.text}`);
}

/** Score context entries against a query (token overlap on content+tags) and
 *  the retrieved files (file/anchor overlap); render the top matches as
 *  `Remembered:` header lines. Returns "" when nothing scores. */
function matchRememberedFacts(
  query: string,
  retrievedFiles: FileNode[],
  entries: ContextEntry[],
  ctx: ServerContext,
): string {
  if (entries.length === 0) return "";
  const qTokens = new Set(tokenizeQuery(query));
  const retrievedPaths = new Set(retrievedFiles.map((f) => f.path));

  const scored = entries
    .map((e) => {
      let score = 0;
      for (const t of tokenizeQuery(`${e.content} ${e.tags.join(" ")}`)) {
        if (qTokens.has(t)) score += 1;
      }
      if (
        e.files.some((f) => retrievedPaths.has(f)) ||
        e.anchors?.some((a) => retrievedPaths.has(a.path))
      ) {
        score += 2;
      }
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, PACK_FACTS_MAX);

  if (scored.length === 0) return "";
  // factLine renders "- [kind] …" — reuse it, swapping the list dash for the label.
  return `${scored.map((x) => `Remembered: ${factLine(x.e, ctx.graph).slice(2)}`).join("\n")}\n`;
}

// Resolve a graph_read target's file part to a FileNode. Exact path wins; on a
// miss, fall back to a unique path-suffix match so a shortened target like
// "appsettings.json" finds "api/.../appsettings.json". Only serves the fallback
// when EXACTLY one file matches — multiple matches are reported as ambiguous
// rather than guessing. (#11)
export type FileTargetResult = { node: FileNode } | { ambiguous: string[] } | { none: true };

export function resolveFileTarget(graph: GraphSchema, filePath: string): FileTargetResult {
  const files = graph.nodes.filter((n): n is FileNode => n.kind === "file");
  const exact = files.find((n) => n.path === filePath);
  if (exact) return { node: exact };

  const suffix = "/" + filePath;
  const matches = files.filter((n) => n.path.endsWith(suffix));
  if (matches.length === 1) return { node: matches[0]! };
  if (matches.length > 1) return { ambiguous: matches.map((n) => n.path) };
  return { none: true };
}

const DEPS_SIG_MAX = 140;
const DEPS_MAX_CALLEES = 10;
const DEPS_MAX_CALLERS = 12;
const TESTS_MAX_FILES = 6;

/**
 * Dependency surface for a symbol, rendered as a point-of-use footer for
 * graph_read: the symbols it CALLS (with full signatures + graph_read targets —
 * so the agent edits against real signatures instead of guessing or re-reading
 * the callee files) and the symbols that CALL it (names only — cheap "a change
 * here affects these" awareness). Built from the v0.3.0 symbol→symbol `calls`
 * edges. Returns "" when the symbol has no call edges (leaf — keep reads lean).
 */
export function buildDepsFooter(
  symbol: SymbolNode,
  graph: GraphSchema,
  maxChars = loadConfig().readDepsMaxChars,
): string {
  const symById = new Map<string, SymbolNode>();
  for (const n of graph.nodes) if (n.kind === "symbol") symById.set(n.id, n);

  const calleeIds: string[] = [];
  const callerIds: string[] = [];
  const seenCallee = new Set<string>();
  const seenCaller = new Set<string>();
  for (const e of graph.edges) {
    if (e.kind !== "calls") continue;
    if (e.from === symbol.id && e.to !== symbol.id && !seenCallee.has(e.to)) {
      seenCallee.add(e.to);
      calleeIds.push(e.to);
    } else if (e.to === symbol.id && e.from !== symbol.id && !seenCaller.has(e.from)) {
      seenCaller.add(e.from);
      callerIds.push(e.from);
    }
  }

  const resolve = (ids: string[]): SymbolNode[] =>
    ids.map((id) => symById.get(id)).filter((n): n is SymbolNode => !!n);
  const callees = resolve(calleeIds).sort((a, b) =>
    a.file === b.file ? a.start_line - b.start_line : a.file < b.file ? -1 : 1,
  );
  const callers = resolve(callerIds);

  if (callees.length === 0 && callers.length === 0) return "";

  const lines: string[] = [];
  let used = 0;

  if (callees.length > 0) {
    const head = "Depends on (signatures — don't guess these):";
    lines.push(head);
    used += head.length + 1;
    let shown = 0;
    for (const c of callees.slice(0, DEPS_MAX_CALLEES)) {
      const sig = c.signature.trim().slice(0, DEPS_SIG_MAX);
      const entry = `• ${sig}   → mcp__synthra__graph_read("${c.file}::${c.name}")`;
      if (used + entry.length + 1 > maxChars) break;
      lines.push(entry);
      used += entry.length + 1;
      shown += 1;
    }
    const omitted = callees.length - shown;
    if (omitted > 0) lines.push(`…+${omitted} more`);
  }

  if (callers.length > 0) {
    const sep = lines.length > 0 ? 1 : 0;
    const head = `Used by (${callers.length}): `;
    const shown: string[] = [];
    let cUsed = used + sep + head.length;
    for (const c of callers.slice(0, DEPS_MAX_CALLERS)) {
      const part = `${c.name} → ${c.file}`;
      const join = shown.length > 0 ? 3 : 0; // " · "
      if (cUsed + join + part.length > maxChars) break;
      shown.push(part);
      cUsed += join + part.length;
    }
    if (lines.length > 0) lines.push("");
    if (shown.length > 0) {
      const omitted = callers.length - shown.length;
      lines.push(head + shown.join(" · ") + (omitted > 0 ? ` …+${omitted} more` : ""));
    } else {
      lines.push(`Used by (${callers.length} callers)`);
    }
  }

  return lines.join("\n");
}

/**
 * Test-coverage footer for graph_read: which test files cover this symbol's file
 * (file-level `tests` edges — foo.test.ts → foo.ts). Lets the agent run the
 * right test after an edit instead of guessing or running the whole suite.
 * Returns a one-line "none linked" nudge for ordinary source files, and "" for
 * symbols that live in a test/entry file (no nudge there).
 */
export function buildTestsFooter(symbol: SymbolNode, graph: GraphSchema): string {
  const fileNode = graph.nodes.find(
    (n): n is FileNode => n.kind === "file" && n.path === symbol.file,
  );
  if (!fileNode) return "";
  const tests = findTestsForFile(graph, fileNode);
  if (tests.length > 0) {
    const shown = tests.slice(0, TESTS_MAX_FILES).map((t) => t.path);
    const omitted = tests.length - shown.length;
    const more = omitted > 0 ? ` …+${omitted} more` : "";
    return `Tests (file-level): ${shown.join(" · ")}${more}  — run after editing`;
  }
  // No linked tests — nudge only for ordinary source files (entry/test files excluded).
  if (isLikelyEntry(symbol.file)) return "";
  return "Tests: none linked to this file.";
}

const FACTS_MAX = 3;
const FACTS_CONTENT_MAX = 160;
const PACK_FACTS_MAX = 2;

/** Which anchored files changed since this entry was stored. Empty = fresh or
 *  unanchored (old entries without anchors are never flagged). Exported for tests. */
export function staleAnchorPaths(entry: ContextEntry, graph: GraphSchema): string[] {
  if (!entry.anchors || entry.anchors.length === 0) return [];
  const hashByPath = new Map<string, string>();
  for (const n of graph.nodes) if (n.kind === "file") hashByPath.set(n.path, n.file_hash);
  return entry.anchors.filter((a) => hashByPath.get(a.path) !== a.hash).map((a) => a.path);
}

function factLine(entry: ContextEntry, graph: GraphSchema): string {
  const content =
    entry.content.length > FACTS_CONTENT_MAX
      ? `${entry.content.slice(0, FACTS_CONTENT_MAX - 1)}…`
      : entry.content;
  const date = entry.date ? ` (${entry.date.slice(0, 10)})` : "";
  const stale = staleAnchorPaths(entry, graph);
  const staleNote = stale.length ? `  ⚠ possibly stale — ${stale[0]} changed since stored` : "";
  return `- [${entry.type}] ${content}${date}${staleNote}`;
}

function entryLinksFile(entry: ContextEntry, filePath: string): boolean {
  if (entry.anchors?.some((a) => a.path === filePath)) return true;
  // files[] holds caller-supplied paths — accept exact or suffix matches, the
  // same leniency resolveFileTarget gives graph_read targets.
  return entry.files.some((f) => f === filePath || filePath.endsWith(`/${f}`));
}

/**
 * Remembered-knowledge footer for graph_read: the context-store entries linked
 * to this file (via `files`/anchors), newest first, each flagged when its
 * anchored content has changed since capture. This is the recall half of the
 * second brain — 152 remembers : 1 recall said the store was write-only.
 */
export function buildFactsFooter(
  filePath: string,
  entries: ContextEntry[],
  graph: GraphSchema,
): string {
  const linked = entries.filter((e) => entryLinksFile(e, filePath));
  if (linked.length === 0) return "";
  const newestFirst = linked.slice().reverse(); // store is append-ordered
  const shown = newestFirst.slice(0, FACTS_MAX);
  const omitted = newestFirst.length - shown.length;
  const lines = ["📌 Remembered for this file:", ...shown.map((e) => factLine(e, graph))];
  if (omitted > 0) lines.push(`…+${omitted} more — mcp__synthra__context_recall()`);
  return lines.join("\n");
}

/** Best-effort read of the branch's context entries — the memory layer must
 *  never break a graph read/pack. */
async function safeRecallAll(ctx: ServerContext): Promise<ContextEntry[]> {
  try {
    return (await recallEntries(ctx.paths, {})).entries;
  } catch {
    return [];
  }
}

async function graphRead(args: Record<string, unknown> | undefined, ctx: ServerContext) {
  const target = typeof args?.target === "string" ? args.target : "";
  if (!target) return errorContent("graph_read: 'target' (string) is required");

  const [rawFile, symbolName] = target.includes("::") ? target.split("::", 2) : [target, undefined];
  const filePath = (rawFile ?? "").trim();

  const resolved = resolveFileTarget(ctx.graph, filePath);
  if ("ambiguous" in resolved) {
    const shown = resolved.ambiguous.slice(0, 5).join(", ");
    const more = resolved.ambiguous.length > 5 ? ", …" : "";
    return errorContent(
      `graph_read: '${filePath}' matches multiple files (${shown}${more}). Pass a longer path.`,
    );
  }
  if ("none" in resolved) {
    return errorContent(`graph_read: file not found in graph: ${filePath}`);
  }
  const fileNode = resolved.node;

  // The AI deliberately pulled this file — the strongest "this matters" signal
  // short of an edit. Feed it to the learning layer.
  await logAccess(ctx, { ts: nowIso(), path: fileNode.path, source: "read" });

  const facts = buildFactsFooter(fileNode.path, await safeRecallAll(ctx), ctx.graph);
  const factsBlock = facts ? `\n\n---\n${facts}` : "";

  if (!symbolName) {
    return textContent(`# ${fileNode.path}\n\n${fileNode.content}${factsBlock}`);
  }

  const cleanSym = symbolName.trim();
  const symbol = ctx.graph.nodes.find(
    (n): n is SymbolNode => n.kind === "symbol" && n.file === fileNode.path && n.name === cleanSym,
  );
  if (!symbol) {
    return errorContent(`graph_read: symbol '${cleanSym}' not found in ${fileNode.path}`);
  }

  const lines = fileNode.content.split(/\r?\n/);
  const body = lines.slice(symbol.start_line - 1, symbol.end_line).join("\n");

  // Point-of-use edit recipe. Claude Code's Edit tool only accepts a file
  // opened with its own Read tool — this slice doesn't satisfy that gate — so
  // without this nudge agents re-Read the whole file before editing (the
  // dogfood log's biggest token leak: the same large file Read 15-19× a
  // session). Hand them the exact targeted Read that satisfies the gate cheaply,
  // with 2 lines of headroom each side for off-by-one safety + unique Edit context.
  const offset = Math.max(1, symbol.start_line - 2);
  const limit = symbol.end_line - symbol.start_line + 1 + 4;
  const editHint =
    `\n\n---\n✎ To edit this symbol: Read("${fileNode.path}", offset=${offset}, limit=${limit}) ` +
    `then Edit — that satisfies Claude Code's read-gate at ~${limit} lines; do NOT re-read the whole file.`;

  const deps = buildDepsFooter(symbol, ctx.graph);
  const depsBlock = deps ? `\n\n---\n${deps}` : "";

  const tests = buildTestsFooter(symbol, ctx.graph);
  const testsBlock = tests ? `\n\n---\n${tests}` : "";

  return textContent(
    `# ${fileNode.path}::${symbol.name}  (L${symbol.start_line}-${symbol.end_line})\n\n${body}${depsBlock}${testsBlock}${factsBlock}${editHint}`,
  );
}

const editedFiles = new Set<string>();

async function graphRegisterEdit(args: Record<string, unknown> | undefined, ctx: ServerContext) {
  const files = Array.isArray(args?.files)
    ? (args.files as unknown[]).filter((f) => typeof f === "string")
    : [];
  for (const f of files) {
    const file = f as string;
    editedFiles.add(file);
    // An edit is the strongest relevance signal — record it (weight 2). Resolve
    // to the canonical graph path so it keys to the same node the ranker scores;
    // a new/renamed file simply logs its raw path and decays out if unmatched.
    const resolved = resolveFileTarget(ctx.graph, file);
    await logAccess(ctx, {
      ts: nowIso(),
      path: "node" in resolved ? resolved.node.path : file,
      source: "register_edit",
    });
  }
  return textContent(
    `Registered ${files.length} edited file(s). Total tracked this session: ${editedFiles.size}.`,
  );
}

export function getRegisteredEdits(): string[] {
  return Array.from(editedFiles);
}

const VALID_KINDS = new Set<EntryKind>(["decision", "task", "next", "fact", "blocker"]);

async function contextRemember(args: Record<string, unknown> | undefined, ctx: ServerContext) {
  const text = typeof args?.text === "string" ? args.text.trim() : "";
  const kindRaw = typeof args?.kind === "string" ? args.kind : "";
  if (!text) return errorContent("context_remember: 'text' (string) is required");
  if (!VALID_KINDS.has(kindRaw as EntryKind)) {
    return errorContent(
      `context_remember: 'kind' must be one of ${Array.from(VALID_KINDS).join(", ")}`,
    );
  }
  const tags = Array.isArray(args?.tags)
    ? (args.tags as unknown[]).filter((t): t is string => typeof t === "string")
    : [];
  const files = Array.isArray(args?.files)
    ? (args.files as unknown[]).filter((f): f is string => typeof f === "string")
    : [];

  // Staleness anchors: snapshot each linked file's content hash from the live
  // graph, so recall can flag this entry when the code moves on. Files the
  // graph doesn't know simply get no anchor (never flagged).
  const anchors: EntryAnchor[] = [];
  for (const f of files) {
    const resolved = resolveFileTarget(ctx.graph, f);
    if ("node" in resolved) {
      anchors.push({ path: resolved.node.path, hash: resolved.node.file_hash });
    }
  }

  const result = await rememberEntry(ctx.paths, {
    text,
    kind: kindRaw as EntryKind,
    tags,
    files,
    anchors,
  });

  const anchorNote = anchors.length
    ? `\nAnchored to ${anchors.length} file(s) — recall will flag this entry if they change.`
    : "";
  return textContent(
    `Remembered ${result.entry.type} on branch '${result.branch}'.\n` +
      `Stored: ${result.storePath}\n` +
      `CONTEXT.md refreshed: ${result.contextMdPath}${anchorNote}`,
  );
}

const DEFAULT_RECENT_WINDOW_MS = 60 * 60 * 1000;

function recentActivity(args: Record<string, unknown> | undefined, ctx: ServerContext) {
  const sinceMs =
    typeof args?.since_ms === "number" && Number.isFinite(args.since_ms)
      ? args.since_ms
      : Date.now() - DEFAULT_RECENT_WINDOW_MS;
  const limit =
    typeof args?.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : undefined;

  let events = ctx.activity.getEvents(sinceMs);
  if (limit) events = events.slice(-limit);

  if (events.length === 0) {
    return textContent(`No human-activity events since ${new Date(sinceMs).toISOString()}.`);
  }

  const lines = [`# Recent human activity (${events.length} events)`, ""];
  for (const e of events) {
    if ("path" in e) {
      lines.push(`- **${e.kind}** ${e.path}  _(${e.ts})_`);
    } else {
      const summary = JSON.stringify(e.details);
      lines.push(`- **${e.kind}** ${summary}  _(${e.ts})_`);
    }
  }
  return textContent(lines.join("\n"));
}

async function contextRecall(args: Record<string, unknown> | undefined, ctx: ServerContext) {
  const kind =
    typeof args?.kind === "string" && VALID_KINDS.has(args.kind as EntryKind)
      ? (args.kind as EntryKind)
      : undefined;
  const branch = typeof args?.branch === "string" ? args.branch : undefined;
  const limit =
    typeof args?.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : undefined;

  const result = await recallEntries(ctx.paths, { kind, branch, limit });

  if (result.entries.length === 0) {
    const filter = kind ? ` of kind '${kind}'` : "";
    return textContent(`No context entries${filter} on branch '${result.branch}'.`);
  }

  const lines = [`# Context entries — branch: ${result.branch}`, ""];
  for (const e of result.entries) {
    const tags = e.tags.length ? ` [${e.tags.join(", ")}]` : "";
    const stale = staleAnchorPaths(e, ctx.graph);
    const staleNote = stale.length
      ? `  ⚠ possibly stale — ${stale.join(", ")} changed since stored`
      : "";
    lines.push(`- **${e.type}**${tags} (${e.date}): ${e.content}${staleNote}`);
    if (e.files.length) lines.push(`  files: ${e.files.join(", ")}`);
  }
  return textContent(lines.join("\n"));
}

// Best-effort per-call log of Synthra MCP tool usage — powers the dashboard's
// graph-tool-usage metric (#2). A positive signal (how often the graph was
// actually used) vs the blocked-Grep proxy, which misses well-behaved pivots.
async function logToolCall(ctx: ServerContext, tool: string): Promise<void> {
  try {
    await mkdir(dirname(ctx.paths.toolLog), { recursive: true });
    await appendFile(
      ctx.paths.toolLog,
      JSON.stringify({ ts: new Date().toISOString(), tool }) + "\n",
      "utf8",
    );
  } catch {
    // Logging is best-effort; never fail a tool call over it.
  }
}

// Best-effort per-file usage capture (learning layer). Routes through the learn
// runtime when present (folds the decayed aggregate in memory + appends the raw
// log); otherwise appends the raw log directly so a runtime-less context (tests,
// CLI) still records signal. Never throws — callers await it but its own errors
// are swallowed, so telemetry can never fail a tool call.
async function logAccess(ctx: ServerContext, ev: AccessEvent): Promise<void> {
  try {
    if (ctx.learn) await ctx.learn.record(ev);
    else await appendAccess(ctx.paths.accessLog, ev);
  } catch {
    // best-effort
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function handleMcpRequest(
  body: unknown,
  ctx: ServerContext,
): Promise<JsonRpcResponse> {
  if (!body || typeof body !== "object") {
    return err(null, ERR.invalidRequest, "Request body must be a JSON-RPC 2.0 object.");
  }

  const req = body as JsonRpcRequest;
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return err(req.id ?? null, ERR.invalidRequest, "Invalid JSON-RPC envelope.");
  }

  const id = req.id ?? null;

  try {
    switch (req.method) {
      case "initialize":
        return ok(id, {
          protocolVersion:
            typeof req.params?.protocolVersion === "string"
              ? req.params.protocolVersion
              : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });

      case "notifications/initialized":
        // Client confirms initialization. No response required for notifications (id===undefined).
        return ok(id, {});

      case "tools/list":
        return ok(id, { tools: TOOLS });

      case "tools/call": {
        const params = req.params ?? {};
        const toolName = typeof params.name === "string" ? params.name : "";
        if (!toolName) return err(id, ERR.invalidParams, "'name' is required for tools/call.");
        const args =
          params.arguments && typeof params.arguments === "object"
            ? (params.arguments as Record<string, unknown>)
            : {};
        void logToolCall(ctx, toolName);
        const result = await callTool(toolName, args, ctx);
        return ok(id, result);
      }

      case "ping":
        return ok(id, {});

      default:
        return err(id, ERR.methodNotFound, `Method not found: ${req.method}`);
    }
  } catch (e) {
    return err(id, ERR.internal, (e as Error).message);
  }
}

// Exposed for code that wants to enumerate the tool catalogue without going
// through JSON-RPC (e.g. CLI introspection in M3).
export function listTools(): Array<{ name: string; description: string; inputSchema: unknown }> {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}
