// Claude Code settings that can switch Synthra off while every file looks
// fine: hooks disabled, only the organization's hooks allowed, MCP servers
// limited to an allowlist or a managed-mcp.json. Read from the files Synthra
// can see; MDM, registry and claude.ai console policies can't be read here,
// which is why doctor also checks that Claude really connected.
//
// Paths and keys: code.claude.com/docs/en/managed-settings (2026-10).

import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where Claude Code looks for an organization's settings on this OS. */
export function managedDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  return "/etc/claude-code";
}

export interface PolicyFinding {
  status: "warn" | "fail";
  text: string;
}

type Settings = Record<string, unknown>;

async function readJson(path: string): Promise<Settings | null> {
  try {
    const v = JSON.parse(await readFile(path, "utf8")) as unknown;
    return v && typeof v === "object" ? (v as Settings) : null;
  } catch {
    return null;
  }
}

const exists = (path: string) =>
  readFile(path).then(
    () => true,
    () => false,
  );

/** An allow or deny entry that names Synthra: by server name, or by its
 *  local URL. */
function namesSynthra(entry: unknown): boolean {
  const s = JSON.stringify(entry ?? "").toLowerCase();
  return s.includes('"synthra"') || s.includes("127.0.0.1") || s.includes("localhost");
}

export async function claudePolicy(
  projectRoot: string,
  opts: { home?: string; systemDir?: string } = {},
): Promise<PolicyFinding[]> {
  const home = opts.home ?? homedir();
  const sys = opts.systemDir ?? managedDir();
  const managedParts = [
    await readJson(join(sys, "managed-settings.json")),
    ...(await Promise.all(
      (
        await readdir(join(sys, "managed-settings.d")).catch(() => [] as string[])
      )
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => readJson(join(sys, "managed-settings.d", f))),
    )),
  ].filter((s): s is Settings => s !== null);
  const ownFiles: [string, Settings | null][] = [
    ["~/.claude/settings.json", await readJson(join(home, ".claude", "settings.json"))],
    [".claude/settings.json", await readJson(join(projectRoot, ".claude", "settings.json"))],
    [
      ".claude/settings.local.json",
      await readJson(join(projectRoot, ".claude", "settings.local.json")),
    ],
  ];

  const out: PolicyFinding[] = [];
  const managed = (key: string) => managedParts.map((s) => s[key]).filter((v) => v !== undefined);

  // Hooks.
  if (managed("disableAllHooks").includes(true)) {
    out.push({ status: "fail", text: "your organization's settings turn all hooks off" });
  }
  for (const [name, s] of ownFiles) {
    if (s?.disableAllHooks === true) {
      out.push({ status: "fail", text: `"disableAllHooks": true in ${name} turns all hooks off` });
    }
  }
  if (managed("allowManagedHooksOnly").includes(true)) {
    out.push({
      status: "warn",
      text: "your organization allows only its own hooks (allowManagedHooksOnly), so Synthra's hooks may not run",
    });
  }

  // MCP servers.
  const denied = managed("deniedMcpServers").flat();
  if (denied.some(namesSynthra)) {
    out.push({
      status: "fail",
      text: "your organization's deniedMcpServers blocks Synthra's MCP server",
    });
  }
  const allowed = managed("allowedMcpServers");
  const lock = managed("allowManagedMcpServersOnly").includes(true);
  if ((lock || allowed.length > 0) && !allowed.flat().some(namesSynthra)) {
    out.push({
      status: "warn",
      text: "your organization's MCP allowlist (allowedMcpServers) doesn't name Synthra, so Claude may not load its tools",
    });
  }
  if (await exists(join(sys, "managed-mcp.json"))) {
    out.push({
      status: "warn",
      text: "a managed-mcp.json is installed; it usually decides alone which MCP servers load, so Synthra's may be left out",
    });
  }
  return out;
}
