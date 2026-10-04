// The Synthra panels in the activity bar: Memory, Capabilities, Agents. Native
// tree views over the running server's GET /panels. What each tree contains is
// decided in panelTrees.ts (pure, tested); this file renders it, watches the
// files behind it, and runs the clicks.

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";

import { tildify } from "./panelTabs";

import {
  agentsView,
  capabilitiesView,
  type DiffSide,
  learningView,
  memoryView,
  PANELS_VERSION,
  type PanelNode,
  type PanelsPayload,
  type PanelTarget,
  type PanelView,
} from "./panelTrees";

export const PANEL_IDS = {
  learning: "synthra.learning",
  memory: "synthra.memory",
  capabilities: "synthra.capabilities",
  agents: "synthra.agents",
} as const;
type Panel = keyof typeof PANEL_IDS;
const PANELS = Object.keys(PANEL_IDS) as Panel[];

export const OPEN_COMMAND = "synthra.panels.open";
/** Read-only documents for a skill change's before/after. */
const DIFF_SCHEME = "synthra-skill";

/** Synthra and Claude rewrite several files per change: read once after they settle. */
const DEBOUNCE_MS = 800;

class NodeTree implements vscode.TreeDataProvider<PanelNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private roots: PanelNode[] = [];

  set(nodes: PanelNode[]): void {
    this.roots = nodes;
    this.changed.fire();
  }

  getChildren(node?: PanelNode): PanelNode[] {
    return node ? (node.children ?? []) : this.roots;
  }

  getTreeItem(n: PanelNode): vscode.TreeItem {
    const state = n.children?.length
      ? n.expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(n.label, state);
    item.id = n.id;
    if (n.description) item.description = n.description;
    // A plain string, never a MarkdownString (see PanelNode.tooltip).
    if (n.tooltip) item.tooltip = n.tooltip;
    if (n.icon) {
      item.iconPath = new vscode.ThemeIcon(
        n.icon.id,
        n.icon.color ? new vscode.ThemeColor(n.icon.color) : undefined,
      );
    }
    if (n.open) item.command = { command: OPEN_COMMAND, title: "Open", arguments: [n.open] };
    if (n.contextValue) item.contextValue = n.contextValue;
    return item;
  }

  dispose(): void {
    this.changed.dispose();
  }
}

export interface PanelDeps {
  /** The running server's port, or null when Synthra is not running. */
  port(): number | null;
  /** What the panels say while there is no port: starting, failed, or stopped. */
  notRunning(): string;
  getJson<T>(url: string, timeoutMs: number): Promise<{ status: number; body: T | null }>;
  postJson<T>(
    url: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<{ status: number; body: T | null }>;
  log(line: string): void;
}

/** What the panels last read: the server's answer, or the one line shown
 *  instead of it. The large panel (editorPanel.ts) renders the same state. */
export type PanelsState =
  | { kind: "payload"; payload: PanelsPayload }
  | { kind: "message"; text: string };

export class SynthraPanels implements vscode.Disposable {
  private readonly trees: Record<Panel, NodeTree> = {
    learning: new NodeTree(),
    memory: new NodeTree(),
    capabilities: new NodeTree(),
    agents: new NodeTree(),
  };
  private readonly views: Record<Panel, vscode.TreeView<PanelNode>>;
  private readonly disposables: vscode.Disposable[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  /** A skill or agent file changed since the last read: rescan them. */
  private fresh = false;
  private reading = false;
  private again = false;
  private current: PanelsState = { kind: "message", text: "Reading what Synthra knows…" };
  private readonly changed = new vscode.EventEmitter<PanelsState>();
  /** Fires after every read, with what it found. */
  readonly onDidChange = this.changed.event;

  /** `folder` is the project Synthra runs for; null when no folder is open. */
  constructor(
    private readonly folder: string | null,
    private readonly deps: PanelDeps,
  ) {
    const make = (p: Panel) =>
      vscode.window.createTreeView(PANEL_IDS[p], {
        treeDataProvider: this.trees[p],
        showCollapseAll: p !== "agents",
      });
    this.views = {
      learning: make("learning"),
      memory: make("memory"),
      capabilities: make("capabilities"),
      agents: make("agents"),
    };
    this.disposables.push(...Object.values(this.views), ...Object.values(this.trees), this.changed);
    for (const v of Object.values(this.views)) {
      this.disposables.push(v.onDidChangeVisibility((e) => e.visible && this.refresh()));
    }
    this.disposables.push(
      vscode.commands.registerCommand(OPEN_COMMAND, (t: PanelTarget) => this.open(t)),
      vscode.commands.registerCommand("synthra.panels.refresh", () =>
        this.refresh({ fresh: true }),
      ),
      // The ✓ / ✗ on a proposal in the Learning panel: the node's id ends in
      // the proposal's id.
      vscode.commands.registerCommand("synthra.skills.approve", (n?: PanelNode) =>
        this.answerFromTree(n, "approve"),
      ),
      vscode.commands.registerCommand("synthra.skills.reject", (n?: PanelNode) =>
        this.answerFromTree(n, "reject"),
      ),
      // The Curator's rows: pin a stale skill, unpin a pinned one, restore an
      // archived one. The path is the end of the node's id.
      vscode.commands.registerCommand("synthra.skills.pin", (n?: PanelNode) =>
        this.fromTree(n, "learn:stale:", (p) => this.curatorAction({ pin: p, on: true })),
      ),
      vscode.commands.registerCommand("synthra.skills.unpin", (n?: PanelNode) =>
        this.fromTree(n, "learn:pinned:", (p) => this.curatorAction({ pin: p, on: false })),
      ),
      vscode.commands.registerCommand("synthra.skills.restore", (n?: PanelNode) =>
        this.fromTree(n, "learn:archived:", (p) => this.curatorAction({ restore: p })),
      ),
      vscode.commands.registerCommand("synthra.curator.run", () =>
        this.curatorAction({ run: true }).then((error) => {
          if (error) void vscode.window.showWarningMessage(`Synthra: ${error}`);
          else void vscode.window.showInformationMessage("Synthra: the Curator ran.");
        }),
      ),
      vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, {
        provideTextDocumentContent: (uri) => this.diffTexts.get(uri.query) ?? "",
      }),
    );

    if (folder) {
      // The files behind each panel. A skill, agent or MCP change needs a
      // rescan (`fresh`): the server keeps its skill list for 15 seconds.
      const project = vscode.Uri.file(folder);
      const home = vscode.Uri.file(homedir());
      const watch = (base: vscode.Uri, glob: string, fresh: boolean) => {
        const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, glob));
        const fire = () => this.refresh({ fresh });
        w.onDidCreate(fire);
        w.onDidChange(fire);
        w.onDidDelete(fire);
        this.disposables.push(w);
      };
      watch(project, ".synthra/**/context-store.json", false);
      watch(project, ".synthra/MEMORY.md", false);
      watch(home, ".synthra/USER.md", false);
      watch(project, ".synthra-graph/delegation_log.jsonl", false);
      watch(project, ".claude/{skills,agents}/**", true);
      watch(project, ".mcp.json", true);
      watch(home, ".claude/{skills,agents}/**", true);
      // Proposals arriving or answered, and the change ledger.
      watch(home, ".synthra/skills/{pending/*.json,ledger.jsonl}", false);
    }
    this.refresh();
  }

  get state(): PanelsState {
    return this.current;
  }

  /** Read the panels again (debounced; one read at a time). */
  refresh(opts: { fresh?: boolean } = {}): void {
    if (opts.fresh) this.fresh = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.read();
    }, DEBOUNCE_MS);
  }

  private async read(): Promise<void> {
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    try {
      await this.load();
    } catch (e) {
      this.deps.log(`[ext] could not read the panels: ${(e as Error).message}`);
    } finally {
      this.reading = false;
      if (this.again) {
        this.again = false;
        void this.read();
      }
    }
  }

  private async load(): Promise<void> {
    if (!this.folder) return this.showOnly("Open a folder to see what Synthra knows about it.");
    const port = this.deps.port();
    if (port === null) return this.showOnly(this.deps.notRunning());

    const fresh = this.fresh;
    this.fresh = false;
    const r = await this.deps.getJson<PanelsPayload>(
      `http://127.0.0.1:${port}/panels${fresh ? "?fresh=1" : ""}`,
      10_000,
    );
    // Stopped or restarted while we waited: the next state change reads again.
    if (this.deps.port() !== port) return;

    if (r.status === 404) {
      return this.showOnly(
        "This version of Synthra has no panels. Update Synthra to 0.33 or later.",
      );
    }
    if (r.status !== 200 || !r.body) {
      if (fresh) this.fresh = true; // the rescan still has to happen
      this.deps.log(`[ext] panels: no answer (status ${r.status || "no response"}).`);
      return this.showOnly("Synthra did not answer. See the log (Synthra: Show log).");
    }
    if (r.body.version !== PANELS_VERSION) {
      return this.showOnly(
        r.body.version > PANELS_VERSION
          ? "This Synthra is newer than the extension. Update the Synthra extension."
          : "This Synthra is older than the extension. Update Synthra.",
      );
    }

    const now = Date.now();
    this.show("learning", learningView(r.body, now));
    this.badge(r.body.learning?.pending.length ?? 0);
    this.show("memory", memoryView(r.body, now));
    this.show("capabilities", capabilitiesView(r.body));
    this.show("agents", agentsView(r.body, now));
    this.publish({ kind: "payload", payload: r.body });
  }

  private publish(s: PanelsState): void {
    this.current = s;
    this.changed.fire(s);
  }

  private show(p: Panel, v: PanelView): void {
    this.trees[p].set(v.nodes);
    this.views[p].message = v.message;
    this.views[p].description = v.description;
  }

  /** The count on the activity-bar icon: skills waiting for the user. */
  private badge(waiting: number): void {
    this.views.learning.badge = waiting
      ? {
          value: waiting,
          tooltip: `${waiting === 1 ? "A skill waits" : `${waiting} skills wait`} for your OK`,
        }
      : undefined;
  }

  /** The same line in every panel, and no rows. */
  private showOnly(message: string): void {
    for (const p of PANELS) this.show(p, { nodes: [], message });
    this.badge(0);
    this.publish({ kind: "message", text: message });
  }

  /**
   * Change one setting (value null = back to its default) through the running
   * server, then read again so every view shows it. Resolves to "" on
   * success, or the reason it was refused.
   */
  async setSetting(key: string, value: number | boolean | null): Promise<string> {
    const port = this.deps.port();
    if (port === null) return "Synthra is not running, so settings can't be changed right now.";
    const r = await this.deps.postJson<{ ok?: boolean; error?: string }>(
      `http://127.0.0.1:${port}/settings`,
      { key, value },
      10_000,
    );
    if (r.status === 404)
      return "This version of Synthra has no settings. Update Synthra to 0.33 or later.";
    if (r.status !== 200 || !r.body)
      return "Synthra did not answer. See the log (Synthra: Show log).";
    this.refresh();
    return r.body.ok ? "" : (r.body.error ?? "The setting was not saved.");
  }

  /**
   * Approve or reject a skill proposal through the running server, then read
   * again. Resolves to "" on success, or the reason it didn't happen.
   */
  async answer(id: string, verdict: "approve" | "reject"): Promise<string> {
    const port = this.deps.port();
    if (port === null) return "Synthra is not running.";
    const r = await this.deps.postJson<{ ok?: boolean; error?: string }>(
      `http://127.0.0.1:${port}/skills/${verdict}`,
      { id },
      10_000,
    );
    this.refresh();
    if (r.status !== 200 || !r.body)
      return "Synthra did not answer. See the log (Synthra: Show log).";
    return r.body.ok ? "" : (r.body.error ?? "Nothing happened.");
  }

  /**
   * Pin/unpin a skill, restore an archived one, or run the Curator now —
   * through the server, which checks the path is one it knows. Resolves to ""
   * on success, or the reason it didn't happen.
   */
  async curatorAction(
    a: { pin: string; on: boolean } | { restore: string } | { run: true },
  ): Promise<string> {
    const port = this.deps.port();
    if (port === null) return "Synthra is not running.";
    const [route, body] =
      "pin" in a
        ? ["/skills/pin", { path: a.pin, on: a.on }]
        : "restore" in a
          ? ["/skills/restore", { archivePath: a.restore }]
          : ["/curator/run", {}];
    const r = await this.deps.postJson<{ ok?: boolean; error?: string }>(
      `http://127.0.0.1:${port}${route}`,
      body,
      30_000,
    );
    this.refresh({ fresh: true });
    if (r.status === 404) return "This version of Synthra has no Curator. Update Synthra.";
    if (r.status !== 200 || !r.body)
      return "Synthra did not answer. See the log (Synthra: Show log).";
    return r.body.ok ? "" : (r.body.error ?? "Nothing happened.");
  }

  /**
   * Delete a skill: the server moves it to the archive (Restore in the
   * Learning tab brings it back). The caller has asked the user first.
   * Resolves to "" on success, or the reason it didn't happen.
   */
  async deleteSkill(path: string): Promise<string> {
    return this.skillPost("/skills/delete", { path }, "delete skills");
  }

  /** Approve or reject every change of one merge, in order, as one answer. */
  async answerGroup(group: string, verdict: "approve" | "reject"): Promise<string> {
    return this.skillPost("/skills/answer-group", { group, verdict }, "answer a merge at once");
  }

  /**
   * Save a backup of what lives on this machine only (skills for every
   * project, USER.md, favorites, history) where the user picks. Resolves to
   * the line to show, or why not; both "" when the user cancelled.
   */
  async backup(): Promise<{ text: string; error: string }> {
    const port = this.deps.port();
    if (port === null) return { text: "", error: "Synthra is not running." };
    const day = new Date().toISOString().slice(0, 10);
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(join(homedir(), `synthra-backup-${day}.json`)),
      filters: { "Synthra backup": ["json"] },
      saveLabel: "Save backup",
    });
    if (!target) return { text: "", error: "" };
    const r = await this.deps.getJson<{ skills?: unknown[] }>(
      `http://127.0.0.1:${port}/backup`,
      60_000,
    );
    if (r.status === 404) {
      return {
        text: "",
        error: "This version of Synthra can't make backups. Update Synthra to 0.37 or later.",
      };
    }
    if (r.status !== 200 || !r.body) {
      return { text: "", error: "Synthra did not answer. See the log (Synthra: Show log)." };
    }
    await writeFile(target.fsPath, `${JSON.stringify(r.body, null, 2)}\n`, "utf8");
    const n = Array.isArray(r.body.skills) ? r.body.skills.length : 0;
    return {
      text: `Saved ${tildify(target.fsPath)} (${n} skill${n === 1 ? "" : "s"}). It holds your notes about yourself: keep it private.`,
      error: "",
    };
  }

  /**
   * Merge a backup file into this machine: what is missing is added, what
   * differs waits in the Learning tab. Resolves to the report's lines and the
   * reinstall commands; all empty when the user cancelled.
   */
  async restore(): Promise<{ lines: string[]; reinstall: string[]; error: string }> {
    const none = { lines: [], reinstall: [] };
    const port = this.deps.port();
    if (port === null) return { ...none, error: "Synthra is not running." };
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      defaultUri: vscode.Uri.file(homedir()),
      filters: { "Synthra backup": ["json"] },
      openLabel: "Restore",
    });
    const file = picked?.[0];
    if (!file) return { ...none, error: "" };
    let backup: unknown;
    try {
      backup = JSON.parse(await readFile(file.fsPath, "utf8"));
    } catch {
      return { ...none, error: "That file isn't a Synthra backup (it isn't valid JSON)." };
    }
    const r = await this.deps.postJson<{
      ok?: boolean;
      error?: string;
      lines?: string[];
      report?: { reinstall?: { command?: string }[] };
    }>(`http://127.0.0.1:${port}/restore`, { backup }, 120_000);
    this.refresh({ fresh: true });
    if (r.status === 404) {
      return {
        ...none,
        error: "This version of Synthra can't restore backups. Update Synthra to 0.37 or later.",
      };
    }
    if (r.status !== 200 || !r.body) {
      return { ...none, error: "Synthra did not answer. See the log (Synthra: Show log)." };
    }
    if (!r.body.ok) return { ...none, error: r.body.error ?? "Nothing was restored." };
    return {
      lines: r.body.lines ?? [],
      reinstall: (r.body.report?.reinstall ?? []).flatMap((x) =>
        typeof x.command === "string" ? [x.command] : [],
      ),
      error: "",
    };
  }

  private async skillPost(route: string, body: unknown, what: string): Promise<string> {
    const port = this.deps.port();
    if (port === null) return "Synthra is not running.";
    const r = await this.deps.postJson<{ ok?: boolean; error?: string }>(
      `http://127.0.0.1:${port}${route}`,
      body,
      30_000,
    );
    this.refresh({ fresh: true });
    if (r.status === 404)
      return `This version of Synthra can't ${what}. Update Synthra to 0.36 or later.`;
    if (r.status !== 200 || !r.body)
      return "Synthra did not answer. See the log (Synthra: Show log).";
    return r.body.ok ? "" : (r.body.error ?? "Nothing happened.");
  }

  private async fromTree(
    n: PanelNode | undefined,
    prefix: string,
    act: (rest: string) => Promise<string>,
  ): Promise<void> {
    if (!n?.id.startsWith(prefix)) return;
    const error = await act(n.id.slice(prefix.length));
    if (error) void vscode.window.showWarningMessage(`Synthra: ${error}`);
  }

  private async answerFromTree(n: PanelNode | undefined, verdict: "approve" | "reject") {
    const id = n?.id.startsWith("learn:pending:") ? n.id.slice("learn:pending:".length) : undefined;
    if (!id) return;
    const error = await this.answer(id, verdict);
    if (error) void vscode.window.showWarningMessage(`Synthra: ${error}`);
    else if (verdict === "approve")
      void vscode.window.showInformationMessage(
        n?.contextValue === "synthraArchiveProposal"
          ? `Synthra: "${n.label}" is archived. Restore it from the Curator any time.`
          : `Synthra: "${n?.label}" is live.`,
      );
  }

  /** The texts the open diffs show, by the query of their virtual URIs. */
  private readonly diffTexts = new Map<string, string>();

  private async side(s: DiffSide): Promise<string | null> {
    if (s === null) return "";
    if ("text" in s) return s.text;
    const port = this.deps.port();
    if (port === null) return null;
    const r = await this.deps.getJson<{ found: boolean; text?: string }>(
      `http://127.0.0.1:${port}/skills/blob?sha=${encodeURIComponent(s.sha)}`,
      10_000,
    );
    return r.body?.found ? (r.body.text ?? "") : null;
  }

  private async showDiff(t: Extract<PanelTarget, { kind: "diff" }>): Promise<void> {
    const [before, after] = await Promise.all([this.side(t.before), this.side(t.after)]);
    if (before === null || after === null) {
      void vscode.window.showInformationMessage("Synthra kept no copy of this change.");
      return;
    }
    const key = (side: string) => {
      const k = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${side}`;
      this.diffTexts.set(k, side === "before" ? before : after);
      // Only the latest few diffs stay readable; older tabs show empty.
      while (this.diffTexts.size > 40) {
        const first = this.diffTexts.keys().next().value;
        if (first === undefined) break;
        this.diffTexts.delete(first);
      }
      return vscode.Uri.from({
        scheme: DIFF_SCHEME,
        path: `/${t.name}/${t.file ?? "SKILL.md"}`,
        query: k,
      });
    };
    await vscode.commands.executeCommand("vscode.diff", key("before"), key("after"), t.title, {
      preview: true,
    });
  }

  /** Open a file a row points at. The large panel's clicks land here too. */
  async open(t: PanelTarget): Promise<void> {
    if (t.kind === "diff") return this.showDiff(t);
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(t.path));
      const pos = t.line ? new vscode.Position(Math.max(0, t.line - 1), 0) : undefined;
      await vscode.window.showTextDocument(doc, {
        preview: t.preview ?? true,
        ...(pos ? { selection: new vscode.Range(pos, pos) } : {}),
      });
    } catch {
      void vscode.window.showInformationMessage(`That file is not there any more: ${t.path}`);
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
  }
}
