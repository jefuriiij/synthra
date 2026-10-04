// The large Synthra panel: an editor tab with the sidebar's content as tabs
// (Memory, Capabilities, Agents), laid out like Hermes Studio's panel tabs but
// with no chat — Claude Code already has that. It renders the state the
// sidebar already read (SynthraPanels), so opening it costs no extra request.
//
// One panel per window. It survives a window reload through the serializer
// (activationEvents: onWebviewPanel:synthra.panel).

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

import { buildHtml } from "./html";
import { buildTabs, mergePrompt, messageTabs, tildify } from "./panelTabs";
import type { PanelTarget } from "./panelTrees";
import type { PanelsState, SynthraPanels } from "./panels";
import type { CapabilityRow, HostToWebview, Tab, WebviewToHost } from "./shared/tabs";

export const PANEL_VIEW_TYPE = "synthra.panel";

export class SynthraEditorPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  /** What the keys of the last view open. Only these can be opened. */
  private targets = new Map<string, PanelTarget>();
  /** The Curator paths the last view offered: only these can be pinned or
   *  restored from the page. */
  private curatorPaths = new Set<string>();
  /** The skill rows the last view's Capabilities tab offered actions on, by
   *  path: only these can be starred, deleted or merged from the page. */
  private skillRows = new Map<string, CapabilityRow>();
  /** The merge groups the last view's Learning tab showed. */
  private groups = new Set<string>();
  /** The last restore's reinstall commands: the only ones "reinstall" runs. */
  private reinstall: string[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    /** The project's folder; null when no folder is open. */
    private readonly folder: string | null,
    private readonly source: SynthraPanels,
    private readonly log: (line: string) => void,
  ) {
    this.disposables.push(
      source.onDidChange((s) => this.publish(s)),
      vscode.window.registerWebviewPanelSerializer(PANEL_VIEW_TYPE, {
        deserializeWebviewPanel: async (panel) => this.adopt(panel),
      }),
    );
  }

  /** A tab to bring up once the page has loaded (it can't hear us before). */
  private pendingTab?: Tab;

  /** Open the panel, or bring it to the front — on `tab`, when given. */
  show(tab?: Tab): void {
    if (this.panel) {
      this.panel.reveal(undefined, false);
      if (tab) this.post({ type: "showTab", tab });
      return;
    }
    this.pendingTab = tab;
    const panel = vscode.window.createWebviewPanel(
      PANEL_VIEW_TYPE,
      "Synthra",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      this.options(),
    );
    this.adopt(panel);
  }

  private options(): vscode.WebviewOptions & vscode.WebviewPanelOptions {
    return {
      enableScripts: true,
      // Keeps the tab, filter and scroll when the panel is hidden behind
      // another editor, instead of rebuilding it each time.
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")],
    };
  }

  private adopt(panel: vscode.WebviewPanel): void {
    if (this.panel) {
      // A second restored panel (two were open before a reload): keep one.
      panel.dispose();
      this.panel.reveal(undefined, false);
      return;
    }
    this.panel = panel;
    const webview = panel.webview;
    webview.options = this.options();
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, "resources", "synthra-light.svg"),
      dark: vscode.Uri.joinPath(this.extensionUri, "resources", "synthra-dark.svg"),
    };
    const asset = (file: string) =>
      webview
        .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", file))
        .toString();
    webview.html = buildHtml({
      cspSource: webview.cspSource,
      nonce: randomBytes(16).toString("base64"),
      scriptUri: asset("webview.js"),
      styleUri: asset("webview.css"),
    });

    const subs: vscode.Disposable[] = [
      webview.onDidReceiveMessage((m: unknown) => this.receive(m)),
      panel.onDidChangeViewState(() => {
        // Back on screen: what it shows may be minutes old.
        if (panel.visible) this.source.refresh();
      }),
    ];
    panel.onDidDispose(() => {
      for (const s of subs) s.dispose();
      if (this.panel === panel) this.panel = undefined;
    });
    this.source.refresh();
  }

  private receive(m: unknown): void {
    if (typeof m !== "object" || m === null) return;
    const msg = m as WebviewToHost;
    switch (msg.type) {
      case "ready":
        this.publish(this.source.state);
        if (this.pendingTab) this.post({ type: "showTab", tab: this.pendingTab });
        this.pendingTab = undefined;
        return;
      case "answer": {
        if (typeof msg.id !== "string" || (msg.verdict !== "approve" && msg.verdict !== "reject"))
          return;
        void this.source
          .answer(msg.id, msg.verdict)
          .then((error) => this.post({ type: "answerResult", id: msg.id, error }));
        return;
      }
      case "pin":
      case "restore":
      case "runCurator": {
        const target =
          msg.type === "pin" ? msg.path : msg.type === "restore" ? msg.archivePath : "run";
        if (
          msg.type !== "runCurator" &&
          (typeof target !== "string" || !this.curatorPaths.has(target))
        ) {
          this.log("[ext] ignored a Curator action the current view does not offer");
          return;
        }
        const action =
          msg.type === "pin"
            ? { pin: msg.path, on: msg.on === true }
            : msg.type === "restore"
              ? { restore: msg.archivePath }
              : ({ run: true } as const);
        void this.source
          .curatorAction(action)
          .then((error) => this.post({ type: "curatorResult", target, error }));
        return;
      }
      case "favorite": {
        const row = typeof msg.path === "string" ? this.skillRows.get(msg.path) : undefined;
        if (!row?.canFavorite) {
          this.log("[ext] ignored a favorite the current view does not offer");
          return;
        }
        void this.source
          .curatorAction({ pin: msg.path, on: msg.on === true })
          .then((error) => this.post({ type: "skillResult", target: msg.path, error }));
        return;
      }
      case "deleteSkill": {
        const row = typeof msg.path === "string" ? this.skillRows.get(msg.path) : undefined;
        if (!row?.canDelete) {
          this.log("[ext] ignored a delete the current view does not offer");
          return;
        }
        void this.confirmDelete(row).then(async (yes) => {
          const error = yes ? await this.source.deleteSkill(msg.path) : "";
          this.post({ type: "skillResult", target: msg.path, error });
        });
        return;
      }
      case "mergeSkills": {
        const rows = Array.isArray(msg.paths)
          ? msg.paths.flatMap((p) => {
              const r = typeof p === "string" ? this.skillRows.get(p) : undefined;
              return r?.canMerge && r.path ? [{ name: r.name, path: r.path }] : [];
            })
          : [];
        if (rows.length < 2) {
          this.post({ type: "mergeResult", error: "Pick at least two skills to merge." });
          return;
        }
        void vscode.env.clipboard.writeText(mergePrompt(rows)).then(() => {
          void vscode.window.showInformationMessage(
            `Synthra: the request to merge ${rows.length} skills is on your clipboard. Paste it in Claude Code; every change waits for your OK in the Learning tab.`,
          );
          this.post({ type: "mergeResult", error: "" });
        });
        return;
      }
      case "answerGroup": {
        if (
          typeof msg.group !== "string" ||
          !this.groups.has(msg.group) ||
          (msg.verdict !== "approve" && msg.verdict !== "reject")
        ) {
          this.log("[ext] ignored a merge answer the current view does not offer");
          return;
        }
        void this.source
          .answerGroup(msg.group, msg.verdict)
          .then((error) => this.post({ type: "answerResult", id: msg.group, error }));
        return;
      }
      case "backup": {
        void this.source
          .backup()
          .catch((e: Error) => ({ text: "", error: `The backup failed: ${e.message}` }))
          .then((r) => this.post({ type: "backupResult", ...r }));
        return;
      }
      case "restoreBackup": {
        void this.source
          .restore()
          .catch((e: Error) => ({
            lines: [],
            reinstall: [],
            error: `The restore failed: ${e.message}`,
          }))
          .then((r) => {
            // Only a command the engine wrote, in the shape it writes them.
            this.reinstall = r.reinstall.filter((c) =>
              /^npx skills add [A-Za-z0-9_.:/-]+ -g -s [A-Za-z0-9._:-]+$/.test(c),
            );
            this.post({
              type: "restoreResult",
              lines: r.lines,
              reinstall: this.reinstall.length,
              error: r.error,
            });
          });
        return;
      }
      case "reinstall": {
        if (this.reinstall.length === 0) return;
        const t = vscode.window.createTerminal({ name: "Synthra: reinstall skills" });
        t.show();
        for (const c of this.reinstall) t.sendText(c);
        return;
      }
      case "setSetting": {
        if (typeof msg.key !== "string") return;
        const value =
          typeof msg.value === "number" || typeof msg.value === "boolean" ? msg.value : null;
        void this.source
          .setSetting(msg.key, value)
          .then((error) => this.post({ type: "settingResult", key: msg.key, error }));
        return;
      }
      case "refresh":
        this.post({ type: "refreshing", on: true });
        this.source.refresh({ fresh: true });
        return;
      case "open": {
        const t = typeof msg.key === "string" ? this.targets.get(msg.key) : undefined;
        if (t) void this.source.open(t);
        else this.log("[ext] ignored a panel click that the current view does not offer");
        return;
      }
    }
  }

  private publish(s: PanelsState): void {
    if (!this.panel) return;
    const folder = this.folder ?? "";
    const built = s.kind === "payload" ? buildTabs(folder, s.payload) : messageTabs(folder, s.text);
    this.targets = built.targets;
    const c = built.view.learning?.curator;
    this.curatorPaths = new Set([
      ...(c?.stale.map((x) => x.path) ?? []),
      ...(c?.pinned.map((x) => x.path) ?? []),
      ...(c?.archived.map((x) => x.archivePath) ?? []),
    ]);
    this.skillRows = new Map(
      (built.view.capabilities?.skills ?? []).flatMap((r) =>
        r.path ? [[r.path, r] as const] : [],
      ),
    );
    this.groups = new Set(
      (built.view.learning?.pending ?? []).flatMap((p) => (p.group ? [p.group] : [])),
    );
    this.post({ type: "view", view: built.view });
    this.post({ type: "refreshing", on: false });
  }

  /** VS Code's own dialog, so a delete is never one stray click. */
  private async confirmDelete(row: CapabilityRow): Promise<boolean> {
    const archive =
      row.scope === "project"
        ? `.synthra/skills-archive/${row.name} in this project`
        : `~/.synthra/skills/archive/${row.name}`;
    const detail = [
      `It moves to ${archive}. You can restore it from the Learning tab.`,
      row.linkedTo
        ? `It is a link to ${tildify(row.linkedTo)}. Only the link moves; that folder is not touched.`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const pick = await vscode.window.showWarningMessage(
      `Delete the skill "${row.name}"?`,
      { modal: true, detail },
      "Delete",
    );
    return pick === "Delete";
  }

  private post(msg: HostToWebview): void {
    void this.panel?.webview.postMessage(msg);
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
