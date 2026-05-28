// MCP-over-HTTP (streamable) protocol handler. Exposes Synthra's graph tools
// to Claude Code via JSON-RPC 2.0 messages POSTed to /mcp.
//
// Tools:
//   graph_continue(query)            — retrieve + pack a context bundle
//   graph_read(target)               — return source for "file" or "file::symbol"
//   graph_register_edit(files)       — Claude tells Synthra it edited files
//
// Spec: https://modelcontextprotocol.io/specification

import { retrieve } from "../graph/retrieve.js";
import type { FileNode, SymbolNode } from "../graph/types.js";
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
        query: { type: "string", description: "Natural-language description of what you're looking for." },
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
    default:
      return errorContent(`Unknown tool: ${name}`);
  }
}

async function graphContinue(args: Record<string, unknown> | undefined, ctx: ServerContext) {
  const query = typeof args?.query === "string" ? args.query : "";
  if (!query) return errorContent("graph_continue: 'query' (string) is required");

  const retrieval = await retrieve(ctx.graph, query);
  const packed = await pack(retrieval.files, { query, graph: ctx.graph });

  const header =
    `Confidence: ${retrieval.confidence}\n` +
    `Files: ${retrieval.files.map((f) => f.path).join(", ") || "(none)"}\n` +
    `Reason: ${retrieval.reason}\n`;

  // The pack body already starts with a header — keep them concatenated.
  return textContent(`${header}\n${packed.text}`);
}

function graphRead(args: Record<string, unknown> | undefined, ctx: ServerContext) {
  const target = typeof args?.target === "string" ? args.target : "";
  if (!target) return errorContent("graph_read: 'target' (string) is required");

  const [rawFile, symbolName] = target.includes("::") ? target.split("::", 2) : [target, undefined];
  const filePath = (rawFile ?? "").trim();

  const fileNode = ctx.graph.nodes.find(
    (n): n is FileNode => n.kind === "file" && n.path === filePath,
  );
  if (!fileNode) return errorContent(`graph_read: file not found in graph: ${filePath}`);

  if (!symbolName) {
    return textContent(`# ${fileNode.path}\n\n${fileNode.content}`);
  }

  const cleanSym = symbolName.trim();
  const symbol = ctx.graph.nodes.find(
    (n): n is SymbolNode => n.kind === "symbol" && n.file === filePath && n.name === cleanSym,
  );
  if (!symbol) {
    return errorContent(`graph_read: symbol '${cleanSym}' not found in ${filePath}`);
  }

  const lines = fileNode.content.split(/\r?\n/);
  const body = lines.slice(symbol.start_line - 1, symbol.end_line).join("\n");
  return textContent(
    `# ${fileNode.path}::${symbol.name}  (L${symbol.start_line}-${symbol.end_line})\n\n${body}`,
  );
}

const editedFiles = new Set<string>();

function graphRegisterEdit(args: Record<string, unknown> | undefined, _ctx: ServerContext) {
  const files = Array.isArray(args?.files) ? (args.files as unknown[]).filter((f) => typeof f === "string") : [];
  for (const f of files) editedFiles.add(f as string);
  return textContent(`Registered ${files.length} edited file(s). Total tracked this session: ${editedFiles.size}.`);
}

export function getRegisteredEdits(): string[] {
  return Array.from(editedFiles);
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
        const args = (params.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {});
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
  return TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}
