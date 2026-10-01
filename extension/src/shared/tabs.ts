// The large Synthra panel (an editor tab): what the host sends the webview, and
// what the webview sends back. Types only — no imports, the webview bundle runs
// in a browser.
//
// The host builds a TabsView from GET /panels (panelTabs.ts) and the webview
// renders it. Times are epoch ms, worded by the webview with its own clock. A
// `key` names something a click opens; the webview sends it back as-is and the
// host opens only keys of the view it last sent — the page can never ask for
// an arbitrary path.

export type Tab = "learning" | "memory" | "capabilities" | "agents" | "settings";

export interface TabsView {
  /** The project folder's name, for the header. */
  project: string;
  /** Set when there is nothing else to show: not running, too old, no answer. */
  message?: string;
  learning?: LearningTab;
  memory?: MemoryTab;
  capabilities?: CapabilitiesTab;
  agents?: AgentsTab;
  settings?: SettingsTab;
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
  /** MEMORY.md and USER.md, in that order (Synthra 0.33+). */
  files: KnowledgeCard[];
  sections: MemorySection[];
}

export interface KnowledgeCard {
  target: "project" | "user";
  title: string;
  /** ".synthra/MEMORY.md", "~/.synthra/USER.md". */
  shownPath: string;
  hint: string;
  exists: boolean;
  /** Model-written: render as text, never as HTML. */
  entries: string[];
  chars: number;
  limit: number;
  /** Opens the file. */
  key?: string;
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

// ─── Learning ───────────────────────────────────────────────────────────────

export interface LearningTab {
  /** "New skills wait for my OK" is on. */
  approval: boolean;
  /** Skills Synthra wrote in the last 7 days, and others it changed. */
  newThisWeek: number;
  improvedThisWeek: number;
  pending: ProposalRow[];
  recent: ChangeRow[];
  learned: LearnedRow[];
}

export interface ProposalRow {
  id: string;
  action: "create" | "patch" | "edit";
  name: string;
  scope: "project" | "global";
  description: string;
  reason?: string;
  at: number;
  /** The file changed since: it can only be rejected. */
  stale: boolean;
  /** Opens the change as a diff. */
  diff: string;
}

export interface ChangeRow {
  id: string;
  action: "create" | "patch" | "edit" | "reject";
  name: string;
  scope: "project" | "global";
  approved: boolean;
  reason?: string;
  at: number;
  /** Opens the change as a diff (or the file, when no copy was kept). */
  key?: string;
}

export interface LearnedRow {
  name: string;
  scope: "project" | "global";
  description: string;
  origin?: string;
  key: string;
}

// ─── Settings ───────────────────────────────────────────────────────────────

export interface SettingsTab {
  /** ~/.synthra/settings.json */
  path: string;
  groups: { name: string; rows: SettingRow[] }[];
}

export interface SettingRow {
  key: string;
  label: string;
  help: string;
  type: "number" | "boolean";
  value: number | boolean;
  default: number | boolean;
  /** "env": an environment variable sets it, so the control is read-only. */
  source: "default" | "file" | "env";
  env: string;
  min?: number;
  max?: number;
  unit?: string;
}

// ─── messages ───────────────────────────────────────────────────────────────

export type HostToWebview =
  | { type: "view"; view: TabsView }
  /** A refresh the user asked for is running (the button spins). */
  | { type: "refreshing"; on: boolean }
  /** Bring a tab to the front (the sidebar's gear opens Settings). */
  | { type: "showTab"; tab: Tab }
  /** A setting change the server refused; `error` is "" once one succeeds. */
  | { type: "settingResult"; key: string; error: string }
  /** How an approve/reject went; `error` is "" when it worked. */
  | { type: "answerResult"; id: string; error: string };

export type WebviewToHost =
  | { type: "ready" }
  | { type: "open"; key: string }
  | { type: "refresh" }
  /** value null = back to the default. */
  | { type: "setSetting"; key: string; value: number | boolean | null }
  | { type: "answer"; id: string; verdict: "approve" | "reject" };
