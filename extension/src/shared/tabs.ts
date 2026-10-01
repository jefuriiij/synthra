// The large Synthra panel (an editor tab): what the host sends the webview, and
// what the webview sends back. Types only — no imports, the webview bundle runs
// in a browser.
//
// The host builds a TabsView from GET /panels (panelTabs.ts) and the webview
// renders it. Times are epoch ms, worded by the webview with its own clock. A
// `key` names something a click opens; the webview sends it back as-is and the
// host opens only keys of the view it last sent — the page can never ask for
// an arbitrary path.

export type Tab = "memory" | "capabilities" | "agents";

export interface TabsView {
  /** The project folder's name, for the header. */
  project: string;
  /** Set when there is nothing else to show: not running, too old, no answer. */
  message?: string;
  memory?: MemoryTab;
  capabilities?: CapabilitiesTab;
  agents?: AgentsTab;
}

// ─── Memory ─────────────────────────────────────────────────────────────────

export interface MemoryTab {
  branch: string;
  total: number;
  /** Notes whose files changed since they were saved. */
  stale: number;
  /** The store couldn't be parsed: `sections` is then empty. */
  unreadable?: string;
  /** Opens the store file (only when unreadable). */
  store?: string;
  /** Opens CONTEXT.md. */
  contextMd?: string;
  sections: MemorySection[];
}

export type MemoryKind = "task" | "blocker" | "next" | "decision" | "fact" | "earlier";

export interface MemorySection {
  kind: MemoryKind;
  label: string;
  hint: string;
  /** Shown folded at first (Earlier tasks). */
  folded: boolean;
  notes: MemoryNote[];
}

export interface MemoryNote {
  id: string;
  /** Model-written: render as text, never as HTML. */
  text: string;
  at?: number;
  tags: string[];
  files: { path: string; key?: string }[];
  /** Files that changed since the note was saved. */
  stale: string[];
}

// ─── Capabilities ───────────────────────────────────────────────────────────

export type CapabilityKind = "skills" | "agents" | "mcp";

export interface CapabilitiesTab {
  error?: string;
  skills: CapabilityRow[];
  agents: CapabilityRow[];
  mcp: CapabilityRow[];
  plugins: PluginRow[];
}

export interface CapabilityRow {
  id: string;
  name: string;
  description: string;
  scope: "project" | "personal" | "plugin";
  /** "This project", "Yours", or the plugin's name — what the chips filter on. */
  group: string;
  /** "12 commands", "sonnet", "http". */
  extra?: string;
  off: boolean;
  /** Opens its file. */
  key?: string;
}

export interface PluginRow {
  name: string;
  skills: number;
  agents: number;
  mcp: number;
  off: boolean;
}

// ─── Agents ─────────────────────────────────────────────────────────────────

export interface AgentsTab {
  recent: AgentRow[];
  /** Per agent, most used first. */
  most: { agent: string; count: number }[];
}

export interface AgentRow {
  id: string;
  /** The task name Claude gave the helper, else the agent's name. */
  title: string;
  agent: string;
  model?: string;
  at: number;
}

// ─── messages ───────────────────────────────────────────────────────────────

export type HostToWebview =
  | { type: "view"; view: TabsView }
  /** A refresh the user asked for is running (the button spins). */
  | { type: "refreshing"; on: boolean };

export type WebviewToHost = { type: "ready" } | { type: "open"; key: string } | { type: "refresh" };
