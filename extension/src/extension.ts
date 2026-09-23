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
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { delimiter, join } from "node:path";
import * as vscode from "vscode";

import {
  adviseUpdate,
  type DoctorReport,
  type Health,
  problemSignature,
  shouldNotify,
  worstOf,
} from "./logic";

/** Matches the CLI's machine-readable ready line (see cli/index.ts). */
const READY_RE = /^\[syn:ready\] (\{.*\})$/m;

/** How long to wait for a stdin-EOF shutdown before resorting to kill(). */
const SHUTDOWN_GRACE_MS = 4000;

/** A health check on window focus, at most this often. */
const FOCUS_RECHECK_MS = 60_000;

const PKG_NAME = "@jefuriiij/synthra";
const REGISTRY_LATEST = `https://registry.npmjs.org/${encodeURIComponent(PKG_NAME)}/latest`;
const INSTALL_CMD = `npm install -g ${PKG_NAME}@latest`;

/** globalState: a version the user chose to skip — shared by every window. */
const SKIPPED_KEY = "synthra.skippedVersion";
/** workspaceState: the problem set we last popped a notification for. */
const NOTIFIED_KEY = "synthra.lastNotifiedProblems";

interface ReadyInfo {
  /** CLI 0.32+. The version of the `syn` process we spawned — when
   *  alreadyRunning, the server that answers is another process, so prefer
   *  the version its /doctor reports. */
  version?: string;
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
let extContext: vscode.ExtensionContext;

/** The last /doctor answer for the running server. */
let health: DoctorReport | null = null;
/** The CLI predates /doctor (< 0.32): no light, no polling, no errors. */
let healthUnsupported = false;
let healthTimer: ReturnType<typeof setInterval> | null = null;
let lastHealthAt = 0;
/** Bumped by every stop/start. A /doctor answer from an older generation is
 *  dropped: during shutdown the server deletes mcp_port a moment BEFORE it stops
 *  answering, so a poll landing in that gap would report "mcp_port is missing"
 *  — and pop a red error — as the window closes. */
let healthGen = 0;
/** Automatic update checks run once per window. The command bypasses this. */
let updateCheckedThisSession = false;

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

function setStatus(text: string, tooltip: string, command?: string, level: Health = "ok"): void {
  status.text = text;
  status.tooltip = tooltip;
  status.command = command ?? "synthra.showOutput";
  // Only these two theme colors are honored for a status bar background — and
  // that's the point: they're the same yellow/red every other extension uses to
  // mean "look at me", so nobody has to learn what ours means.
  status.backgroundColor =
    level === "fail"
      ? new vscode.ThemeColor("statusBarItem.errorBackground")
      : level === "warn"
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
  status.show();
}

const HEALTH_ICON: Record<Health, string> = { ok: "$(pass)", warn: "$(warning)", fail: "$(error)" };

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
      const version = health?.version ?? i.version;
      const level: Health = health?.status ?? "ok";
      const problems = (health?.checks ?? []).filter((c) => c.status !== "ok");
      const lines = [
        `Synthra${version ? ` ${version}` : ""} is running for ${i.projectRoot}`,
        `MCP: ${i.mcpUrl}${i.mcpRegistered ? " (registered)" : " (NOT registered — IDE can't see the tools)"}`,
        i.dashboardUrl ? `Dashboard: ${i.dashboardUrl}` : "Dashboard: not running",
        `Graph: ${i.symbols} symbols · ${i.files} files · ${i.edges} edges`,
        i.alreadyRunning ? "(adopted a server that was already running)" : "",
        ...(problems.length
          ? [
              "",
              "Problems:",
              ...problems.map((c) => `${HEALTH_ICON[c.status]} ${c.label}: ${c.detail}`),
            ]
          : []),
        "",
        problems.length ? "Click for details and Repair." : "Click to open the dashboard.",
      ].filter((l, idx, all) => l !== "" || (idx > 0 && all[idx - 1] !== ""));
      // A problem outranks the dashboard shortcut: when something is wrong, the
      // click should go where the fix is.
      const command = problems.length
        ? "synthra.showHealth"
        : i.dashboardUrl
          ? "synthra.openDashboard"
          : "synthra.showOutput";
      const icon = level === "ok" ? "$(database)" : HEALTH_ICON[level];
      setStatus(`${icon} Synthra ${i.symbols}`, lines.join("\n"), command, level);
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
function resolveExecutable(
  bin: string,
  base: string[] = [".", "--managed"],
): { command: string; args: string[]; shell: boolean } {
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

// ─── small I/O helpers ───────────────────────────────────────────────────────
//
// node:http / node:https rather than fetch(): the engine floor is VS Code 1.75,
// whose extension host is Node 16 — no global fetch there.

/** GET a JSON body. Resolves the HTTP status alongside it so a 404 (a CLI that
 *  predates the route) can be told apart from a network failure. */
function getJson<T>(url: string, timeoutMs: number): Promise<{ status: number; body: T | null }> {
  return new Promise((resolve) => {
    const get = url.startsWith("https:") ? httpsGet : httpGet;
    const req = get(url, { timeout: timeoutMs }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (raw += c));
      res.on("end", () => {
        let body: T | null = null;
        try {
          body = JSON.parse(raw) as T;
        } catch {
          body = null;
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve({ status: 0, body: null }));
  });
}

/** Run `syn <args>` to completion and return its stdout. Uses the same
 *  executable resolution as start(), so it asks the binary we'd actually run. */
function runSyn(args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const bin = config().get<string>("path", "syn") || "syn";
    const exe = resolveExecutable(bin, args);
    let stdout = "";
    let proc: ChildProcess;
    try {
      proc = spawn(exe.command, exe.args, {
        shell: exe.shell,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    proc.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? stdout : null);
    });
  });
}

// ─── health light (A) ────────────────────────────────────────────────────────

/**
 * Ask the running server for its doctor checks and repaint.
 *
 * `full` adds the checks that spawn processes (Node, jq, `claude --version`).
 * Those are asked for once after start, not on every poll: they don't change
 * minute to minute, and `claude --version` is a Node cold start each time.
 */
async function checkHealth(full: boolean): Promise<void> {
  if (state.kind !== "running" || healthUnsupported) return;
  const port = state.info.mcpPort;
  const gen = healthGen;
  lastHealthAt = Date.now();
  const r = await getJson<DoctorReport>(
    `http://127.0.0.1:${port}/doctor${full ? "?env=1" : ""}`,
    full ? 15_000 : 5_000,
  );
  // Stopped, restarting, or restarted while we waited — this answer is stale.
  if (gen !== healthGen || state.kind !== "running" || state.info.mcpPort !== port) return;

  if (r.status === 404) {
    // A CLI older than 0.32. Say it once in the log and step aside: no light,
    // no polling, everything else works exactly as it did.
    healthUnsupported = true;
    stopHealthPolling();
    out.appendLine("[ext] this syn has no /doctor (needs 0.32+) — health light off.");
    return;
  }
  if (r.status !== 200 || !r.body || !Array.isArray(r.body.checks)) {
    // Couldn't reach it this time. Keep the last known state rather than
    // flashing the light for one missed poll; the next poll will tell.
    out.appendLine(`[ext] health check failed (status ${r.status || "no response"}).`);
    return;
  }

  // A light poll carries no environment checks. Keep the ones from the last
  // full check so a real `claude CLI` warning doesn't vanish between polls.
  const report = r.body;
  if (!full && health) {
    const seen = new Set(report.checks.map((c) => c.label));
    const carried = health.checks.filter((c) => !seen.has(c.label) && ENV_LABELS.has(c.label));
    report.checks = [...carried, ...report.checks];
    report.status = worstOf(report.checks);
  }
  health = report;
  render();
  await maybeNotifyHealth(report);
}

/** Checks that only `?env=1` returns — carried between light polls. */
const ENV_LABELS = new Set(["Node", "jq", "claude CLI"]);

async function maybeNotifyHealth(report: DoctorReport): Promise<void> {
  const signature = problemSignature(report.checks);
  const last = extContext.workspaceState.get<string>(NOTIFIED_KEY);
  if (signature === "") {
    // Healthy again: forget what we told them, so a recurrence is news.
    if (last) await extContext.workspaceState.update(NOTIFIED_KEY, "");
    return;
  }
  if (!shouldNotify(signature, last)) return;
  await extContext.workspaceState.update(NOTIFIED_KEY, signature);

  const problems = report.checks.filter((c) => c.status !== "ok");
  const first = problems[0];
  if (!first) return;
  const more = problems.length > 1 ? ` (+${problems.length - 1} more)` : "";
  const text = `Synthra: ${first.label} — ${first.detail}${more}`;
  const show =
    report.status === "fail" ? vscode.window.showErrorMessage : vscode.window.showWarningMessage;
  const pick = await show(text, "Repair", "Details");
  if (pick === "Repair") await repair();
  else if (pick === "Details") await showHealth();
}

function startHealthPolling(): void {
  stopHealthPolling();
  const minutes = config().get<number>("healthCheckMinutes", 5);
  if (!minutes || minutes <= 0) return;
  healthTimer = setInterval(() => void checkHealth(false), minutes * 60_000);
}

function stopHealthPolling(): void {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
}

async function showHealth(): Promise<void> {
  if (state.kind !== "running") {
    vscode.window.showInformationMessage("Synthra isn't running.");
    return;
  }
  if (!health) await checkHealth(true);
  if (!health) {
    vscode.window.showInformationMessage(
      healthUnsupported
        ? "This version of syn can't report health — update Synthra to 0.32 or later."
        : "Synthra didn't answer the health check. See the log.",
    );
    return;
  }

  type Item = vscode.QuickPickItem & { action?: "repair" | "recheck" | "doctor" };
  const items: Item[] = [
    {
      label: "$(tools) Repair",
      description: "restart Synthra — re-runs `syn .`, which reinstalls hooks and re-registers MCP",
      action: "repair",
    },
    { label: "$(refresh) Check again", action: "recheck" },
    { label: "$(terminal) Run full doctor in a terminal", action: "doctor" },
    { label: "", kind: vscode.QuickPickItemKind.Separator },
    ...health.checks.map((c) => ({
      label: `${HEALTH_ICON[c.status]} ${c.label}`,
      detail: c.detail,
    })),
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: `Synthra ${health.version} — ${health.status === "ok" ? "all good" : "needs attention"}`,
    matchOnDetail: true,
  });
  if (pick?.action === "repair") await repair();
  else if (pick?.action === "recheck") {
    await checkHealth(true);
    await showHealth();
  } else if (pick?.action === "doctor") await vscode.commands.executeCommand("synthra.runDoctor");
}

/** Nearly every doctor warning says "run `syn .`". A restart IS `syn .` — the
 *  managed start re-installs hooks, rewrites the policy block and re-registers
 *  MCP — so this one action covers them. */
async function repair(): Promise<void> {
  out.appendLine("[ext] repair: restarting Synthra (re-runs syn .)");
  await stop();
  await start(true);
}

// ─── update button (B) ───────────────────────────────────────────────────────

/**
 * The extension starts `syn` with SYN_NO_UPDATE_CHECK=1 and no terminal, so the
 * CLI's own `Update now? [y/N]` can never appear under it. Before this, a user
 * who only ever opened projects from the editor was never told about an update
 * at all. So the extension does the check itself — in the background, after
 * the server is up, never on the startup path.
 */
async function checkForUpdates(manual: boolean): Promise<void> {
  if (!manual) {
    if (updateCheckedThisSession || !config().get<boolean>("checkForUpdates", true)) return;
    updateCheckedThisSession = true;
  }

  const [latestRes, installedRaw] = await Promise.all([
    getJson<{ version?: string }>(REGISTRY_LATEST, 5_000),
    runSyn(["--version"], 10_000),
  ]);
  const latest = latestRes.body?.version ?? null;
  const installed = installedRaw ? (/(\d+\.\d+\.\d+)/.exec(installedRaw)?.[1] ?? null) : null;
  const running = state.kind === "running" ? (health?.version ?? state.info.version ?? null) : null;

  const advice = adviseUpdate({
    latest,
    installed,
    running,
    // A manual check ignores "skip this version" — the user asked.
    skipped: manual ? null : extContext.globalState.get<string>(SKIPPED_KEY),
  });
  out.appendLine(
    `[ext] update check: latest=${latest ?? "?"} installed=${installed ?? "?"} running=${running ?? "?"} → ${advice.kind}`,
  );

  if (advice.kind === "update") {
    const pick = await vscode.window.showInformationMessage(
      `Synthra ${advice.latest} is available (you have ${advice.current}).`,
      "Update",
      "Later",
      "Skip this version",
    );
    if (pick === "Update") await runUpdate();
    else if (pick === "Skip this version")
      await extContext.globalState.update(SKIPPED_KEY, advice.latest);
    return;
  }
  if (advice.kind === "restart") {
    const pick = await vscode.window.showInformationMessage(
      `Synthra ${advice.installed} is installed, but this window is still running ${advice.running}.`,
      "Restart",
    );
    if (pick === "Restart") await repair();
    return;
  }
  if (manual) {
    vscode.window.showInformationMessage(
      latest
        ? `Synthra is up to date (${installed ?? running ?? latest}).`
        : "Couldn't reach npm to check for updates.",
    );
  }
}

/**
 * Stop, install, start.
 *
 * Stop first: on Windows a running process can hold files npm needs to
 * replace. Install in the background with output in the log, rather than in a
 * terminal, because a terminal gives us no portable way to know when it has
 * finished — and we need to know, to start the server again on the new code.
 */
async function runUpdate(): Promise<void> {
  const wasRunning = state.kind === "running" || state.kind === "starting";
  await stop();
  out.appendLine(`[ext] updating: ${INSTALL_CMD}`);

  const ok = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Updating Synthra…" },
    () =>
      new Promise<boolean>((resolve) => {
        let proc: ChildProcess;
        try {
          // A constant command string through the shell: `npm` is npm.cmd on
          // Windows and needs one, and there's no user input in it to escape.
          proc = spawn(INSTALL_CMD, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
        } catch {
          resolve(false);
          return;
        }
        proc.stdout?.on("data", (d: Buffer) => out.append(d.toString()));
        proc.stderr?.on("data", (d: Buffer) => out.append(d.toString()));
        proc.on("error", () => resolve(false));
        proc.on("exit", (code) => resolve(code === 0));
      }),
  );

  if (ok) {
    out.appendLine("[ext] update installed.");
    // Other windows still run the old code; they'll offer a restart on their
    // next check. This one restarts now.
    if (wasRunning) await start(true);
    const v = await runSyn(["--version"], 10_000);
    vscode.window.showInformationMessage(
      `Synthra updated${v ? ` to ${v.trim().replace(/^syn,?\s*/, "")}` : ""}.`,
    );
    return;
  }

  out.appendLine("[ext] update failed.");
  // Most likely a permissions problem (a system-owned global npm prefix on
  // macOS/Linux). The terminal lets the user see the real error and use sudo.
  const pick = await vscode.window.showErrorMessage(
    "Synthra update failed. See the log for npm's output.",
    "Run in terminal",
    "Show log",
  );
  if (pick === "Run in terminal") {
    const term = vscode.window.createTerminal({ name: "Synthra update" });
    term.sendText(INSTALL_CMD);
    term.show();
  } else if (pick === "Show log") {
    out.show();
  }
  if (wasRunning) await start(true);
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
      // Health first (the update check reads the version it reports), then
      // polling. Both are off the startup path: the server is already usable.
      healthGen++;
      health = null;
      healthUnsupported = false;
      void checkHealth(true).then(() => {
        startHealthPolling();
        return checkForUpdates(false);
      });
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
    healthGen++;
    stopHealthPolling();
    health = null;
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
  // First, before shutdown begins: no poll may land in the window where the
  // server has already released mcp_port but is still answering.
  healthGen++;
  stopHealthPolling();

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
  stopHealthPolling();
  health = null;
  state = { kind: "idle" };
  render();
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extContext = context;
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
    vscode.commands.registerCommand("synthra.showHealth", () => showHealth()),
    vscode.commands.registerCommand("synthra.repair", () => repair()),
    vscode.commands.registerCommand("synthra.checkForUpdates", () => checkForUpdates(true)),

    // Coming back to the window is when you're about to use Synthra — a cheap
    // re-check then catches a fault that appeared while you were away, without
    // waiting out the poll interval.
    vscode.window.onDidChangeWindowState((w) => {
      if (w.focused && Date.now() - lastHealthAt > FOCUS_RECHECK_MS) void checkHealth(false);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("synthra.healthCheckMinutes") && state.kind === "running") {
        startHealthPolling();
      }
    }),
  );

  // Make sure a window close / extension reload never orphans the server.
  context.subscriptions.push({ dispose: () => void stop() });
  context.subscriptions.push({ dispose: () => stopHealthPolling() });

  render();

  if (config().get<boolean>("autoStart", true)) {
    await start(false);
  }
}

export async function deactivate(): Promise<void> {
  await stop();
}
