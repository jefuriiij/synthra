// `syn mcp`: Synthra's tools for MCP clients that start a server as a process
// and talk JSON-RPC over stdin and stdout. Codex is the reason (v0.41): it keeps
// one global list of MCP servers, while each project's Synthra server listens
// on its own port. So Codex starts `syn mcp` once per session, in the session's
// folder, and the bridge finds that folder's server and forwards each message.
//
// Checked on Codex 0.160: it starts a stdio server in the session's working
// folder, speaks MCP 2025-06-18, and runs a tool marked read-only without an
// approval prompt.
//
// The project is the nearest folder, from the working folder up, that holds a
// `.synthra-graph`. Its server is looked up again for every message (the owner
// record plus /health, both local and fast): the server can restart on a new
// port, and an old port can belong to another project by then. While no server
// runs, the bridge still answers the handshake and lists the tools, so a
// session that starts first sees them; a tool call then says how to start it.
//
// stdout carries JSON-RPC only. Nothing else may be written there.

import { createInterface } from "node:readline";

import { type JsonRpcResponse, listedTools, negotiateProtocol } from "../server/mcp.js";
import { setLevel } from "../shared/logger.js";
import { findProjectRoot, liveServer, VIA_HEADER } from "./project-root.js";

export { findProjectRoot };

/** Long enough for a slow tool (a big blast_radius); a stuck server still
 *  gets an answer in the end. */
const CALL_TIMEOUT_MS = 120_000;

interface Message {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: Record<string, unknown>;
}

export interface Bridge {
  /** One line from the client. Returns the line to send back, or null. */
  handle(line: string): Promise<string | null>;
}

export async function createBridge(cwd: string, version: string): Promise<Bridge> {
  const root = await findProjectRoot(cwd);
  /** The client's handshake, sent again to each server the bridge reaches, so
   *  the server records the connection even when it started later. */
  let handshake: Message | null = null;
  /** The server instance that last got the handshake. A restarted server
   *  can come back on the same port, so its start time counts too. */
  let greeted: string | null = null;

  async function post(port: number, msg: Message): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", [VIA_HEADER]: "stdio" },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  }

  /** The server's answer, null for an accepted notification, or undefined
   *  when no server for this project is running. */
  async function forward(msg: Message): Promise<JsonRpcResponse | null | undefined> {
    const server = root ? await liveServer(root) : null;
    if (!server) return undefined;
    const { port } = server;
    if (msg.method !== "initialize" && handshake && greeted !== server.id) {
      await post(port, handshake).catch(() => undefined);
    }
    let res: Response;
    try {
      res = await post(port, msg);
    } catch (e) {
      // The server stopped between the lookup and the call.
      if ((e as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED") return undefined;
      throw e;
    }
    greeted = server.id;
    if (res.status === 202) return null;
    const body = (await res.json().catch(() => null)) as
      | (JsonRpcResponse & { error?: unknown })
      | null;
    if (body && body.jsonrpc === "2.0") return body;
    const why =
      body && typeof (body as { error?: unknown }).error === "string"
        ? (body as unknown as { error: string }).error
        : `HTTP ${res.status}`;
    return failure(msg.id ?? null, -32603, `Synthra's server refused the call: ${why}`);
  }

  function offline(msg: Message): JsonRpcResponse | null {
    if (msg.id === undefined) return null;
    const id = msg.id;
    switch (msg.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: negotiateProtocol(msg.params?.protocolVersion),
            capabilities: { tools: {} },
            serverInfo: { name: "synthra", version },
          },
        };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: listedTools() } };
      case "tools/call":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: root
                  ? `Synthra isn't running for ${root}. Open that folder in VS Code (the Synthra extension starts it), or run \`syn serve\` there, then call the tool again.`
                  : `No Synthra map in ${cwd} or any folder above it. Run \`syn .\` in the project folder first.`,
              },
            ],
            isError: true,
          },
        };
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      default:
        return failure(id, -32601, `Method not found: ${String(msg.method)}`);
    }
  }

  return {
    async handle(line) {
      if (!line.trim()) return null;
      let msg: Message;
      try {
        msg = JSON.parse(line) as Message;
      } catch {
        return JSON.stringify(failure(null, -32700, "Not valid JSON."));
      }
      if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0") {
        return JSON.stringify(failure(null, -32600, "Invalid JSON-RPC envelope."));
      }
      if (msg.method === "initialize") handshake = msg;
      let answer: JsonRpcResponse | null | undefined;
      try {
        answer = await forward(msg);
      } catch (e) {
        answer = failure(msg.id ?? null, -32603, (e as Error).message);
      }
      if (answer === undefined) answer = offline(msg);
      // A notification never gets an answer, whatever the server sent.
      return answer && msg.id !== undefined ? JSON.stringify(answer) : null;
    },
  };
}

function failure(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export async function mcpBridgeCommand(version: string): Promise<void> {
  // Info lines go to stdout, which belongs to JSON-RPC here.
  setLevel("warn");
  const bridge = await createBridge(process.cwd(), version);
  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  const pending = new Set<Promise<void>>();
  lines.on("line", (line) => {
    const job = bridge
      .handle(line)
      .then((out) => {
        if (out) process.stdout.write(`${out}\n`);
      })
      .finally(() => pending.delete(job));
    pending.add(job);
  });
  await new Promise<void>((done) => lines.once("close", () => done()));
  await Promise.all(pending);
}
