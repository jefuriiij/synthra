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

import { retrieve } from "../graph/retrieve.js";
import type { FileNode, GraphSchema, SymbolNode } from "../graph/types.js";
import { appendAccess } from "../learn/store.js";
import type { AccessEvent } from "../learn/usage.js";
import { recallEntries, rememberEntry } from "../memory/index.js";
import type { EntryKind } from "../memory/context-store.js";
import { pack } from "../packer/index.js";
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
      "Return the source code for a specific file or symbol. Target is either a project-relative file path (e.g. 'src/auth.ts') or 'file::symbol' (e.g. 'src/auth.ts::AuthService').",
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
          description: "Optional project-relative file paths this entry relates to.",
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
      "Given a file (or 'file::symbol' target), return all files that depend on it transitively via imports + tests edges. Use BEFORE editing a widely-used file to see what could break. Symbol-level granularity is approximated at the file level (we don't track call edges in v0.1).",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "File path or 'file::symbol' notation." },
        depth: { type: "number", description: "Max hops to traverse. Default 3." },
      },
      required: ["target"],
    },
  },
  {
    name: "dead_code",
    description:
      "Return files in the project that no other file imports and no test file references — strong candidates for unused/orphaned code. File-level granularity (v0.1 limitation — symbol-level needs call-graph edges). Common entry-point patterns (main, index, app, CLI, bin/) are excluded heuristically.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Cap on returned files. Default 50." },
      },
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

  const filePath = targetRaw.split("::", 1)[0]?.trim() ?? targetRaw;
  const root = ctx.graph.nodes.find((n): n is FileNode => n.kind === "file" && n.path === filePath);
  if (!root) return errorContent(`blast_radius: file not in graph: ${filePath}`);

  // Index reverse edges (to → [{from, kind}]) once per call.
  const incoming = new Map<string, Array<{ from: string; kind: string }>>();
  for (const e of ctx.graph.edges) {
    if (e.kind !== "imports" && e.kind !== "tests") continue;
    const list = incoming.get(e.to) ?? [];
    list.push({ from: e.from, kind: e.kind });
    incoming.set(e.to, list);
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
    `_v0.1 caveat:_ this is file-level only. Symbol-level dead code (unused exports) needs call-graph edges, which land in v0.2.`,
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

  // The pack body already starts with a header — keep them concatenated.
  return textContent(`${header}\n${packed.text}`);
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

  if (!symbolName) {
    return textContent(`# ${fileNode.path}\n\n${fileNode.content}`);
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
  return textContent(
    `# ${fileNode.path}::${symbol.name}  (L${symbol.start_line}-${symbol.end_line})\n\n${body}`,
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

  const result = await rememberEntry(ctx.paths, {
    text,
    kind: kindRaw as EntryKind,
    tags,
    files,
  });

  return textContent(
    `Remembered ${result.entry.type} on branch '${result.branch}'.\n` +
      `Stored: ${result.storePath}\n` +
      `CONTEXT.md refreshed: ${result.contextMdPath}`,
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
    lines.push(`- **${e.type}**${tags} (${e.date}): ${e.content}`);
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
