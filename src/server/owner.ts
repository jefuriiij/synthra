// Who owns this project's MCP server right now.
//
// Before v0.26 nothing answered that question: a second `syn` on the same root
// bound another port, overwrote .synthra-graph/mcp_port, and left the first
// server running but unreachable — still watching files, still writing state.
// And because nothing ever unlinked mcp_port, every clean exit left a file
// naming a dead port, which makes all ten hook scripts no-op *silently* (they
// `catch { exit 0 }` by design), quietly disabling the Moat and CONTEXT.md
// refresh.
//
// mcp_port itself stays a bare integer — the hook scripts parse it with
// (Get-Content).Trim() / cat|tr -d, and they're only rewritten on `syn .`, so
// widening it would break every hook already on disk. The ownership metadata
// lives in a sibling file that only `syn` reads.

import { unlink } from "node:fs/promises";

import { readJsonFile, updateJsonFile, writeTextAtomic } from "../shared/json-store.js";
import { log } from "../shared/logger.js";
import type { SynthraPaths } from "../shared/paths.js";

export interface OwnerRecord {
  port: number;
  pid: number;
  /** Guards against a stale port that another project's server now owns. */
  projectRoot: string;
  startedAt: string;
  version: string;
}

const HEALTH_TIMEOUT_MS = 1500;

/** What a Synthra server says about itself on /health. */
export interface HealthInfo {
  project_root: string;
  pid: number;
  port: number;
}

/**
 * Ask whoever holds this port who they are. `null` means nobody answered (or
 * it isn't a Synthra server) — never assume liveness implies ownership: ports
 * are machine-global, so a stale port file can name a port that a *different*
 * project's Synthra has since claimed.
 */
export async function probeHealth(
  port: number,
  timeoutMs = HEALTH_TIMEOUT_MS,
): Promise<HealthInfo | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<HealthInfo> & { ok?: boolean };
    if (body?.ok !== true || typeof body.project_root !== "string") return null;
    return { project_root: body.project_root, pid: Number(body.pid), port: Number(body.port) };
  } catch {
    return null;
  }
}

export type OwnerCheck =
  | { state: "live"; record: OwnerRecord }
  | { state: "none" }
  | { state: "stale"; record: OwnerRecord }
  | { state: "foreign"; record: OwnerRecord; servedRoot: string };

/**
 * Who, if anyone, currently owns this project. "live" means a server for THIS
 * project root is answering on the recorded port — the caller should defer to
 * it rather than starting a rival. "stale" means nobody answered. "foreign"
 * means somebody answered but serves a *different* project: the recorded port
 * was recycled, and talking to it would read and write another project's state.
 */
export async function checkOwner(paths: SynthraPaths): Promise<OwnerCheck> {
  const read = await readJsonFile<OwnerRecord>(paths.mcpOwner);
  if (read.status !== "ok") return { state: "none" };
  const rec = read.data;
  if (typeof rec?.port !== "number" || typeof rec?.projectRoot !== "string") {
    return { state: "none" };
  }
  const health = await probeHealth(rec.port);
  if (!health) return { state: "stale", record: rec };
  if (!sameRoot(health.project_root, paths.projectRoot)) {
    return { state: "foreign", record: rec, servedRoot: health.project_root };
  }
  return { state: "live", record: rec };
}

/** Claim this project: write the owner record + the bare-integer port file. */
export async function claimOwnership(
  paths: SynthraPaths,
  port: number,
  version: string,
): Promise<OwnerRecord> {
  const record: OwnerRecord = {
    port,
    pid: process.pid,
    projectRoot: paths.projectRoot,
    startedAt: new Date().toISOString(),
    version,
  };
  // Claiming is a full replace, not a merge — whoever binds the port owns it.
  await updateJsonFile<OwnerRecord>(
    paths.mcpOwner,
    () => record,
    () => record,
  );
  // Four bytes in one syscall can't tear, and the hooks want exactly this shape.
  await writeTextAtomic(paths.mcpPort, String(port));
  return record;
}

/**
 * Release ownership on shutdown — but only ours. If another server has since
 * claimed the project, its record and port file must survive our exit.
 */
export async function releaseOwnership(paths: SynthraPaths): Promise<void> {
  try {
    const read = await readJsonFile<OwnerRecord>(paths.mcpOwner);
    if (read.status === "ok" && read.data?.pid !== process.pid) return; // not ours
    await unlink(paths.mcpOwner).catch(() => undefined);
    await unlink(paths.mcpPort).catch(() => undefined);
  } catch (err) {
    log.debug(`ownership release skipped: ${(err as Error).message}`);
  }
}

/** Path equality that survives Windows' slash direction and drive-letter case. */
export function sameRoot(a: string, b: string): boolean {
  const norm = (p: string) =>
    p
      .replace(/[\\/]+$/, "")
      .replace(/\\/g, "/")
      .toLowerCase();
  return norm(a) === norm(b);
}
