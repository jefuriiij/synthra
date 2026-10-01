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
import { buildTabs, messageTabs } from "./panelTabs";
import type { PanelTarget } from "./panelTrees";
import type { PanelsState, SynthraPanels } from "./panels";
import type { HostToWebview, Tab, WebviewToHost } from "./shared/tabs";

export const PANEL_VIEW_TYPE = "synthra.panel";

export class SynthraEditorPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  /** What the keys of the last view open. Only these can be opened. */
  private targets = new Map<string, PanelTarget>();
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
    this.post({ type: "view", view: built.view });
    this.post({ type: "refreshing", on: false });
  }

  private post(msg: HostToWebview): void {
    void this.panel?.webview.postMessage(msg);
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
