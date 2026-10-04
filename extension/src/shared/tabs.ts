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
  /** The last check for updates of installed skills (Synthra 0.38+). */
  updates?: { checkedAt: number; errors: string[] };
}

export interface CapabilityRow {
  id: string;
  name: string;
  description: string;
  scope: "project" | "personal" | "plugin";
  /** The section it is listed in: "This project", "Yours", the repo an
   *  installed skill came from ("owner/repo"), or the plugin's name. */
  group: string;
  /** "12 commands", "sonnet", "http". */
  extra?: string;
  off: boolean;
  /** Opens its file. */
  key?: string;
  // Skills only (Synthra 0.36+; absent from an older engine):
  /** The skill's SKILL.md: what favorite, delete and merge act on. */
  path?: string;
  /** Synthra wrote it. */
  synthra?: boolean;
  /** Installed from this repo (npx skills): read-only here. */
  thirdParty?: string;
  /** Its folder is a link to this folder. */
  linkedTo?: string;
  favorite?: boolean;
  /** Synthra's skill, unused this many days (stale). */
  staleDays?: number;
  uses?: number;
  lastUsed?: number;
  /** Support files beside its SKILL.md, each with the key that opens it. */
  files?: { path: string; key: string }[];
  /** Support files not listed. */
  filesMore?: number;
  /** Opens SKILL.md to edit (a kept tab, not a preview). */
  edit?: string;
  canFavorite?: boolean;
  canDelete?: boolean;
  canMerge?: boolean;
  // Installed from GitHub (Synthra 0.38+):
  /** Its name in the lock file: what update and "Don't update" act on. */
  updatable?: string;
  /** A newer version is on GitHub, or its folder moved in its repo. */
  update?: "available" | "moved";
  /** Set to "Don't update". */
  held?: boolean;
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
  /** Synthra 0.33+. */
  curator?: CuratorCard;
}

export interface CuratorCard {
  enabled: boolean;
  /** "2 days ago · 1 stale". */
  lastRun: string;
  nextRunAt?: number;
  staleDays: number;
  archiveDays: number;
  stale: {
    name: string;
    scope: "project" | "global";
    daysUnused: number;
    path: string;
    key: string;
  }[];
  archived: {
    name: string;
    scope: "project" | "global";
    at: number;
    archivePath: string;
    key: string;
  }[];
  pinned: { name: string; scope: "project" | "global"; path: string; key: string }[];
}

export interface ProposalRow {
  id: string;
  action: "create" | "patch" | "edit" | "remove" | "archive";
  /** "New skill", "Change to your skill", "New file references/x.md in",
   *  "Merge into y:", "Archive". */
  title: string;
  /** A change to the user's own skill. */
  yours?: boolean;
  /** The skill's folder is a link: the change is saved in this folder. */
  linkedTo?: string;
  /** Changes of one merge share a group; the Learning tab shows them as one card. */
  group?: string;
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
  action: "create" | "patch" | "edit" | "remove" | "reject" | "archive" | "restore";
  /** A support file the change was about ("references/x.md"). */
  file?: string;
  /** Who did it: the AI, you, or the Curator. */
  actor: "agent" | "user" | "curator";
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
  | { type: "answerResult"; id: string; error: string }
  /** How a Curator action (pin, restore, run now) went, by its target. */
  | { type: "curatorResult"; target: string; error: string }
  /** How a favorite or a delete from Capabilities went, by the skill's path. */
  | { type: "skillResult"; target: string; error: string }
  /** The merge request is on the clipboard (error ""), or why not. */
  | { type: "mergeResult"; error: string }
  /** A backup was saved (`text` says where), or why not. "" both: cancelled. */
  | { type: "backupResult"; text: string; error: string }
  /** What a restore did, line by line, and how many skills to reinstall. */
  | { type: "restoreResult"; lines: string[]; reinstall: number; error: string }
  /** The update check finished: `text` says what it found, or `error` why not. */
  | { type: "updatesResult"; text: string; error: string };

export type WebviewToHost =
  | { type: "ready" }
  | { type: "open"; key: string }
  | { type: "refresh" }
  /** value null = back to the default. */
  | { type: "setSetting"; key: string; value: number | boolean | null }
  | { type: "answer"; id: string; verdict: "approve" | "reject" }
  /** Curator actions. `path` / `archivePath` come from the view the host sent. */
  | { type: "pin"; path: string; on: boolean }
  | { type: "restore"; archivePath: string }
  | { type: "runCurator" }
  /** Capabilities: star or unstar a skill (the server's "pin"). */
  | { type: "favorite"; path: string; on: boolean }
  /** Capabilities: delete a skill (the host asks first). */
  | { type: "deleteSkill"; path: string }
  /** Capabilities: put a merge request for these skills on the clipboard. */
  | { type: "mergeSkills"; paths: string[] }
  /** Learning: approve or reject every change of one merge. */
  | { type: "answerGroup"; group: string; verdict: "approve" | "reject" }
  /** Settings: save a backup file (the host asks where). */
  | { type: "backup" }
  /** Settings: restore from a backup file (the host asks which). */
  | { type: "restoreBackup" }
  /** Settings: run the last restore's reinstall commands in a terminal. */
  | { type: "reinstall" }
  /** Capabilities: ask GitHub which installed skills have updates. */
  | { type: "checkUpdates" }
  /** Capabilities: update these installed skills (lock names; the host asks first). */
  | { type: "updateSkills"; names: string[] }
  /** Capabilities: "Don't update" on or off for one installed skill. */
  | { type: "holdSkill"; name: string; on: boolean }
  /** Capabilities: show what updating one installed skill changes. */
  | { type: "skillChanges"; name: string }
  /** Capabilities: open an installed skill's repo on GitHub. */
  | { type: "openRepo"; repo: string };
