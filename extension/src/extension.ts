// Synthra IDE companion.
//
// The whole point: you open a project, Synthra is already running. No `syn .`.
//
// Design constraints that shaped this file:
//
//   - STOCK VS CODE API ONLY. Antigravity, Cursor and Windsurf are VS Code
//     forks that install from Open VSX; anything Microsoft-specific would make
//     the same .vsix work in one editor and silently fail in another.
//
//   - ONE SERVER PER PROJECT, and Synthra already enforces that itself (v0.26
//     ownership records). So this never tries to be clever about duplicates: it
//     spawns `syn`, and if a live server already owns the folder the CLI says
//     `alreadyRunning` and we just adopt its port. Two windows on one folder is
//     therefore safe, which matters because that is a completely normal thing
//     to do.
//
//   - SHUT DOWN CLEANLY OR NOT AT ALL. Killing `syn` outright would leave
//     .synthra-graph/mcp_port naming a dead port, and because every hook script
//     ends in `catch { exit 0 }`, the Moat and the CONTEXT.md refresh would stop
//     working *silently*. That is the worst possible failure for this feature,
//     so we close the child's stdin and let it run its own shutdown path
//     (`syn . --managed` watches for EOF). kill() is only ever a last resort
//     after a grace period.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import * as vscode from "vscode";

/** Matches the CLI's machine-readable ready line (see cli/index.ts). */
const READY_RE = /^\[syn:ready\] (\{.*\})$/m;

/** How long to wait for a stdin-EOF shutdown before resorting to kill(). */
const SHUTDOWN_GRACE_MS = 4000;

interface ReadyInfo {
  projectRoot: string;
  mcpPort: number;
  mcpUrl: string;
  dashboardUrl: string | null;
  mcpRegistered: boolean;
  alreadyRunning: boolean;
  symbols: number;
  files: number;
  edges: number;
}

type State =
  | { kind: "idle" }
  | { kind: "starting"; folder: string }
  | { kind: "running"; folder: string; info: ReadyInfo }
  | { kind: "failed"; folder: string; message: string };

let child: ChildProcess | null = null;
let state: State = { kind: "idle" };
let status: vscode.StatusBarItem;
let out: vscode.OutputChannel;

function config() {
  return vscode.workspace.getConfiguration("synthra");
}

/** The folder we manage: the first workspace folder. Multi-root workspaces get
 *  the first root only — Synthra is per-project, and guessing which root the
 *  user means would be worse than being predictable. */
function targetFolder(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return folders[0]?.uri.fsPath ?? null;
}

/** Has Synthra ever run here? `.synthra-graph/` is machine-local state and
 *  `.synthra/` is the git-tracked memory, so either one means this is a real
 *  Synthra project rather than a folder we would be bootstrapping uninvited. */
function looksLikeSynthraProject(folder: string): boolean {
  return existsSync(join(folder, ".synthra-graph")) || existsSync(join(folder, ".synthra"));
}

function setStatus(text: string, tooltip: string, command?: string): void {
  status.text = text;
  status.tooltip = tooltip;
  status.command = command ?? "synthra.showOutput";
  status.show();
}

function render(): void {
  switch (state.kind) {
    case "idle":
      setStatus(
        "$(circle-slash) Synthra",
        "Synthra is not running — click to start",
        "synthra.start",
      );
      break;
    case "starting":
      setStatus("$(sync~spin) Synthra", `Starting in ${state.folder}…`, "synthra.showOutput");
      break;
    case "running": {
      const i = state.info;
      const lines = [
        `Synthra is running for ${i.projectRoot}`,
        `MCP: ${i.mcpUrl}${i.mcpRegistered ? " (registered)" : " (NOT registered — IDE can't see the tools)"}`,
        i.dashboardUrl ? `Dashboard: ${i.dashboardUrl}` : "Dashboard: not running",
        `Graph: ${i.symbols} symbols · ${i.files} files · ${i.edges} edges`,
        i.alreadyRunning ? "(adopted a server that was already running)" : "",
        "",
        "Click to open the dashboard.",
      ].filter(Boolean);
      setStatus(
        `$(database) Synthra ${i.symbols}`,
        lines.join("\n"),
        i.dashboardUrl ? "synthra.openDashboard" : "synthra.showOutput",
      );
      break;
    }
    case "failed":
      setStatus(
        "$(warning) Synthra",
        `Failed: ${state.message}\nClick to see the log.`,
        "synthra.showOutput",
      );
      break;
  }
}

/**
 * Find the real `syn` executable on PATH, rather than relying on `shell: true`.
 *
 * Two reasons this is worth doing by hand. First, `shell: true` triggers Node's
 * DEP0190 (args concatenated into a command line, unescaped) — the same
 * deprecation Synthra's own CLI avoids via cross-spawn. Second, and far worse:
 * under a shell on Windows, `syn` runs as a grandchild of an intermediate
 * cmd.exe, so closing our stdin never reaches Node and the graceful
 * shutdown path silently doesn't happen — leaving exactly the stale mcp_port
 * this extension is supposed to prevent. Found by testing shutdown, not by
 * reading the code.
 *
 * npm on Windows installs both `syn` (a shell script) and `syn.cmd`; we want a
 * .cmd/.exe so it can be spawned directly. A `.cmd` still needs a shell to
 * interpret it, so we prefer a real `.exe`, then fall back to the node script
 * the npm shim wraps, and only then to shell mode.
 */
function resolveExecutable(bin: string): { command: string; args: string[]; shell: boolean } {
  const base = [".", "--managed"];

  // An explicit path — take it at face value.
  if (bin.includes("/") || bin.includes("\\")) {
    return { command: bin, args: base, shell: false };
  }

  if (process.platform !== "win32") {
    return { command: bin, args: base, shell: false };
  }

  // Walk PATH looking for the npm-installed shim and, better, the JS entry it
  // points at — running that with our own node avoids cmd.exe entirely.
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    // npm layout: <prefix>/syn.cmd + <prefix>/node_modules/@jefuriiij/synthra/bin/syn
    const cmd = join(dir, `${bin}.cmd`);
    if (!existsSync(cmd)) continue;

    for (const scope of ["@jefuriiij/synthra", bin]) {
      const entry = join(dir, "node_modules", ...scope.split("/"), "bin", "syn");
      if (existsSync(entry)) {
        // Spawn the bin script with the same node that runs the extension host:
        // one process, real stdin, no shell.
        return { command: process.execPath, args: [entry, ...base], shell: false };
      }
    }
    return { command: cmd, args: base, shell: true };
  }

  return { command: bin, args: base, shell: true };
}

async function start(explicit: boolean): Promise<void> {
  const folder = targetFolder();
  if (!folder) {
    if (explicit) vscode.window.showWarningMessage("Synthra: open a folder first.");
    return;
  }
  if (child) {
    if (explicit)
      vscode.window.showInformationMessage("Synthra is already running for this window.");
    return;
  }

  // Auto-start is deliberately conservative: bootstrapping a folder the user
  // never opted into would write .gitignore entries, a CLAUDE.md policy block
  // and .claude/ hooks into someone's unrelated repo. An explicit command
  // bypasses the check — that IS the opt-in.
  if (!explicit && config().get<boolean>("requireExistingProject", true)) {
    if (!looksLikeSynthraProject(folder)) {
      out.appendLine(
        `[ext] ${folder} has no .synthra-graph/ or .synthra/ — skipping auto-start. ` +
          `Run "Synthra: Start for this project" to set it up here.`,
      );
      state = { kind: "idle" };
      render();
      return;
    }
  }

  const bin = config().get<string>("path", "syn") || "syn";
  const exe = resolveExecutable(bin);
  state = { kind: "starting", folder };
  render();
  out.appendLine(`[ext] starting: ${exe.command} ${exe.args.join(" ")}   (cwd: ${folder})`);
  if (exe.shell) {
    // Worth saying out loud: in shell mode the graceful stdin shutdown can't
    // reach the real process, so stopping falls back to kill() and may leave a
    // stale mcp_port behind.
    out.appendLine(
      "[ext] note: falling back to shell spawn — clean shutdown may not be possible. " +
        'Set "synthra.path" to the full path of syn to avoid this.',
    );
  }

  let proc: ChildProcess;
  try {
    proc = spawn(exe.command, exe.args, {
      cwd: folder,
      shell: exe.shell,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, SYN_NO_UPDATE_CHECK: "1" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.appendLine(`[ext] spawn failed: ${message}`);
    state = { kind: "failed", folder, message };
    render();
    return;
  }

  child = proc;
  let buffered = "";
  let sawReady = false;

  proc.stdout?.on("data", (d: Buffer) => {
    const text = d.toString();
    out.append(text);
    if (sawReady) return;
    buffered += text;
    const m = READY_RE.exec(buffered);
    if (!m?.[1]) return;
    try {
      const info = JSON.parse(m[1]) as ReadyInfo;
      sawReady = true;
      state = { kind: "running", folder, info };
      render();
      out.appendLine(`[ext] ready — MCP on :${info.mcpPort}`);
      if (!info.mcpRegistered) {
        vscode.window.showWarningMessage(
          "Synthra started, but registering its MCP server with Claude failed — the IDE won't see graph_* tools. Run `syn doctor` for details.",
        );
      }
      if (info.dashboardUrl && config().get<boolean>("showDashboardNotification", false)) {
        vscode.window.showInformationMessage(`Synthra ready — dashboard at ${info.dashboardUrl}`);
      }
    } catch {
      // Malformed ready line: keep the process, stay in "starting". The log has
      // the raw text, and the user can still see what happened.
    }
  });

  proc.stderr?.on("data", (d: Buffer) => out.append(d.toString()));

  proc.on("error", (err) => {
    const message =
      (err as NodeJS.ErrnoException).code === "ENOENT"
        ? `\`${bin}\` not found on PATH. Install it with: npm install -g @jefuriiij/synthra`
        : err.message;
    out.appendLine(`[ext] error: ${message}`);
    child = null;
    state = { kind: "failed", folder, message };
    render();
    vscode.window.showErrorMessage(`Synthra: ${message}`);
  });

  proc.on("exit", (code, signal) => {
    out.appendLine(`[ext] syn exited (code=${code ?? "null"} signal=${signal ?? "none"})`);
    child = null;
    // A non-zero exit before ready is a real failure worth surfacing; a clean
    // exit is either our own stop() or the user quitting the server themselves.
    if (!sawReady && code !== 0) {
      state = { kind: "failed", folder, message: `syn exited with code ${code}` };
    } else {
      state = { kind: "idle" };
    }
    render();
  });
}

/**
 * Stop by closing stdin, which is the shutdown path `--managed` waits on.
 *
 * Why not just kill(): on Windows there are no real POSIX signals, so kill()
 * becomes TerminateProcess and the CLI's `finally` — which unregisters the MCP
 * entry and deletes mcp_port / mcp_owner.json — never runs. The leftover port
 * file then points at nothing, and every hook silently no-ops. So: ask nicely,
 * wait, and only force it if the process ignores us.
 */
async function stop(): Promise<void> {
  const proc = child;
  if (!proc) return;
  out.appendLine("[ext] stopping (closing stdin so syn can clean up)…");

  const exited = new Promise<void>((resolve) => {
    proc.once("exit", () => resolve());
  });

  try {
    proc.stdin?.end();
  } catch {
    // already gone
  }

  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(true), SHUTDOWN_GRACE_MS)),
  ]);

  if (timedOut) {
    out.appendLine("[ext] syn did not exit in time — forcing it.");
    try {
      proc.kill();
    } catch {
      // nothing more we can do
    }
  }

  child = null;
  state = { kind: "idle" };
  render();
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  out = vscode.window.createOutputChannel("Synthra");
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(out, status);

  context.subscriptions.push(
    vscode.commands.registerCommand("synthra.start", () => start(true)),
    vscode.commands.registerCommand("synthra.stop", () => stop()),
    vscode.commands.registerCommand("synthra.restart", async () => {
      await stop();
      await start(true);
    }),
    vscode.commands.registerCommand("synthra.showOutput", () => out.show()),
    vscode.commands.registerCommand("synthra.openDashboard", () => {
      const url = state.kind === "running" ? state.info.dashboardUrl : null;
      if (!url) {
        vscode.window.showInformationMessage("Synthra's dashboard isn't running.");
        return;
      }
      vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand("synthra.runDoctor", () => {
      const folder = targetFolder();
      if (!folder) {
        vscode.window.showWarningMessage("Synthra: open a folder first.");
        return;
      }
      // A terminal, not a spawn: doctor is for the human to read, and this way
      // its output lands somewhere they can scroll and copy from.
      const bin = config().get<string>("path", "syn") || "syn";
      const term = vscode.window.createTerminal({ name: "Synthra doctor", cwd: folder });
      term.sendText(`${bin} doctor .`);
      term.show();
    }),
  );

  // Make sure a window close / extension reload never orphans the server.
  context.subscriptions.push({ dispose: () => void stop() });

  render();

  if (config().get<boolean>("autoStart", true)) {
    await start(false);
  }
}

export async function deactivate(): Promise<void> {
  await stop();
}
