// The sidebar panels as plain trees: Memory, Capabilities, Agents. Pure — no
// `vscode` import — so the main Synthra test suite can check them; panels.ts
// maps the nodes to TreeItems and runs the clicks. Ids are stable, so a
// refresh keeps what the user expanded.

import { join } from "node:path";

// ─── what GET /panels returns (src/server/routes/panels.ts) ─────────────────
//
// Copied, not imported: the extension is bundled on its own and must not pull
// server code in. tests/extension-panels.test.ts feeds a real server answer
// through these trees, so a drift between the two shows up there.

/** The payload version this extension understands. */
export const PANELS_VERSION = 1;

export type EntryKind = "decision" | "task" | "next" | "fact" | "blocker";

export interface PanelMemoryEntry {
  kind: EntryKind;
  content: string;
  tags: string[];
  files: string[];
  date: string;
  stale: string[];
}

export type ItemScope = "project" | "personal" | "plugin";

export interface PanelItem {
  name: string;
  description: string;
  scope: ItemScope;
  source?: string;
  enabled?: boolean;
  file?: string;
  commands?: number;
  meta?: Record<string, string>;
}

export interface PanelDelegation {
  ts: string;
  agent: string | null;
  model: string | null;
  description: string | null;
  session_id?: string;
}

export interface PanelsPayload {
  version: number;
  project_root: string;
  memory: {
    branch: string;
    store_path: string;
    context_md_path: string;
    unreadable?: string;
    entries: PanelMemoryEntry[];
  };
  capabilities: {
    skills: PanelItem[];
    agents: PanelItem[];
    mcp: PanelItem[];
    scanned_at: string;
    error?: string;
  };
  agents: {
    since: string;
    delegations: PanelDelegation[];
  };
}

// ─── nodes ──────────────────────────────────────────────────────────────────

/** What a click on a node does. */
export type PanelTarget = { kind: "file"; path: string; line?: number };

export interface PanelNode {
  id: string;
  label: string;
  description?: string;
  /** Plain text. The host shows it as-is, never as markdown: memory and skill
   *  texts are model-written and must not render as links or images. */
  tooltip?: string;
  /** A codicon id, and optionally a theme colour id. */
  icon?: { id: string; color?: string };
  open?: PanelTarget;
  children?: PanelNode[];
  /** Initial state of a node with children (the user's choice wins later). */
  expanded?: boolean;
}

/** One panel: its rows, the line shown above them, and the short text next to
 *  its title (undefined = none). */
export interface PanelView {
  nodes: PanelNode[];
  message?: string;
  description?: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const firstLine = (s: string) =>
  s
    .split(/\r?\n/)
    .find((l) => l.trim())
    ?.trim() ?? "";

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", then a date. */
export function relativeTime(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const min = Math.floor((now - at) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.floor(h / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(at).toISOString().slice(0, 10);
}

// ─── Memory ─────────────────────────────────────────────────────────────────

/** Most urgent first: what you are doing, what blocks it, what comes next. */
const KINDS: { kind: EntryKind; label: string; icon: string; tooltip: string }[] = [
  {
    kind: "task",
    label: "Current task",
    icon: "target",
    tooltip: "What is being worked on now.",
  },
  {
    kind: "blocker",
    label: "Blockers",
    icon: "circle-slash",
    tooltip: "Problems that stop the work.",
  },
  { kind: "next", label: "Next steps", icon: "arrow-right", tooltip: "What to do next." },
  {
    kind: "decision",
    label: "Decisions",
    icon: "law",
    tooltip: "Choices made, and why. They come back when Claude touches the files they name.",
  },
  {
    kind: "fact",
    label: "Facts",
    icon: "note",
    tooltip: "Things that are true about this project.",
  },
];

function memoryEntryNode(e: PanelMemoryEntry, index: number, root: string, now: number): PanelNode {
  const when = relativeTime(e.date, now);
  const stale = e.stale.length > 0;
  const tooltip = [
    clip(e.content, 1200),
    e.files.length ? `Files: ${e.files.join(", ")}` : "",
    stale ? `Changed since this was saved: ${e.stale.join(", ")}. It may be out of date.` : "",
    e.tags.length ? `Tags: ${e.tags.join(", ")}` : "",
    e.date ? `Saved ${new Date(e.date).toLocaleString()}` : "",
    e.files[0] ? "Click to open the file." : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const file = e.files[0];
  return {
    id: `mem:${index}`,
    label: clip(firstLine(e.content), 90),
    description: [stale ? "may be out of date" : "", when].filter(Boolean).join(" · "),
    tooltip,
    icon: stale ? { id: "warning", color: "editorWarning.foreground" } : { id: "circle-small" },
    ...(file ? { open: { kind: "file", path: join(root, file) } as const } : {}),
  };
}

export function memoryView(p: PanelsPayload, now: number): PanelView {
  const m = p.memory;
  if (m.unreadable) {
    return {
      nodes: m.store_path
        ? [
            {
              id: "mem:store",
              label: "Open the memory file",
              tooltip: m.store_path,
              icon: { id: "go-to-file" },
              open: { kind: "file", path: m.store_path },
            },
          ]
        : [],
      message: `Synthra can't read this branch's memory file: ${m.unreadable}`,
    };
  }
  if (m.entries.length === 0) {
    return {
      nodes: [],
      message: `Nothing remembered on ${m.branch ? `branch ${m.branch}` : "this branch"} yet. Claude saves notes here with context_remember.`,
    };
  }

  // The store is append-ordered, so its index is a stable id and the newest
  // entry is the last one.
  const indexed = m.entries.map((e, i) => ({ e, i }));
  const nodes: PanelNode[] = [];
  for (const k of KINDS) {
    const list = indexed.filter((x) => x.e.kind === k.kind).reverse();
    if (list.length === 0) continue;
    const stale = list.filter((x) => x.e.stale.length > 0).length;
    nodes.push({
      id: `mem:kind:${k.kind}`,
      label: k.label,
      description: stale ? `${list.length} · ${stale} may be out of date` : String(list.length),
      tooltip: k.tooltip,
      icon: { id: k.icon },
      expanded: k.kind === "task" || k.kind === "blocker" || k.kind === "next",
      children: list.map((x) => memoryEntryNode(x.e, x.i, p.project_root, now)),
    });
  }
  nodes.push({
    id: "mem:contextmd",
    label: "CONTEXT.md",
    description: "the summary in git",
    tooltip:
      "The short summary Synthra writes from these notes. It is tracked in git, so your team sees it too.",
    icon: { id: "book" },
    open: { kind: "file", path: m.context_md_path },
  });
  return { nodes, description: m.branch };
}

// ─── Capabilities ───────────────────────────────────────────────────────────

const SCOPES: { scope: ItemScope; label: string; icon: string }[] = [
  { scope: "project", label: "This project", icon: "repo" },
  { scope: "personal", label: "Yours (all projects)", icon: "person" },
  { scope: "plugin", label: "From plugins", icon: "extensions" },
];

function itemNode(kind: string, i: PanelItem): PanelNode {
  const off = i.enabled === false;
  const description = [
    i.commands ? plural(i.commands, "command") : "",
    kind === "agents" ? (i.meta?.model ?? "") : "",
    kind === "mcp" ? (i.meta?.type ?? "") : "",
    off ? "off" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    id: `cap:${kind}:${i.scope}:${i.source ?? ""}:${i.name}`,
    label: i.name,
    ...(description ? { description } : {}),
    tooltip: [clip(i.description, 600), i.file ? "Click to open its file." : ""]
      .filter(Boolean)
      .join("\n\n"),
    icon: off ? { id: "circle-slash" } : { id: kind === "mcp" ? "plug" : "circle-small" },
    ...(i.file ? { open: { kind: "file", path: i.file } as const } : {}),
  };
}

/** Group one list by scope; plugin items get one more level, by plugin. */
function scopeGroups(kind: string, items: PanelItem[]): PanelNode[] {
  const groups: PanelNode[] = [];
  for (const s of SCOPES) {
    const list = items.filter((i) => i.scope === s.scope);
    if (list.length === 0) continue;
    let children: PanelNode[];
    if (s.scope === "plugin") {
      const names = [...new Set(list.map((i) => i.source ?? "?"))].sort();
      children = names.map((name) => {
        const own = list.filter((i) => (i.source ?? "?") === name);
        return {
          id: `cap:${kind}:plugin:${name}`,
          label: name,
          description: String(own.length),
          icon: { id: "package" },
          expanded: false,
          children: own.map((i) => itemNode(kind, i)),
        };
      });
    } else {
      children = list.map((i) => itemNode(kind, i));
    }
    groups.push({
      id: `cap:${kind}:${s.scope}`,
      label: s.label,
      description: String(list.length),
      icon: { id: s.icon },
      expanded: s.scope === "project",
      children,
    });
  }
  return groups;
}

export function capabilitiesView(p: PanelsPayload): PanelView {
  const c = p.capabilities;
  if (c.error) {
    return { nodes: [], message: `Synthra couldn't list your skills and tools: ${c.error}` };
  }
  const plugins = new Map<string, { skills: number; agents: number; mcp: number; on: boolean }>();
  for (const [kind, list] of [
    ["skills", c.skills],
    ["agents", c.agents],
    ["mcp", c.mcp],
  ] as const) {
    for (const i of list) {
      if (i.scope !== "plugin" || !i.source) continue;
      const row = plugins.get(i.source) ?? { skills: 0, agents: 0, mcp: 0, on: true };
      row[kind] += 1;
      if (i.enabled === false) row.on = false;
      plugins.set(i.source, row);
    }
  }
  return {
    nodes: [
      {
        id: "cap:skills",
        label: "Skills",
        description: String(c.skills.length),
        tooltip: "Step-by-step guides Claude can load when a task needs one.",
        icon: { id: "book" },
        expanded: true,
        children: scopeGroups("skills", c.skills),
      },
      {
        id: "cap:agents",
        label: "Agents",
        description: String(c.agents.length),
        tooltip: "Helpers Claude can hand a task to.",
        icon: { id: "hubot" },
        expanded: false,
        children: scopeGroups("agents", c.agents),
      },
      {
        id: "cap:mcp",
        label: "Connected tools (MCP)",
        description: String(c.mcp.length),
        tooltip: "MCP servers Claude Code connects to.",
        icon: { id: "plug" },
        expanded: false,
        children: scopeGroups("mcp", c.mcp),
      },
      {
        id: "cap:plugins",
        label: "Plugins",
        description: plugins.size ? String(plugins.size) : "none",
        tooltip: "Claude Code plugins, and what each one adds.",
        icon: { id: "extensions" },
        expanded: false,
        children: [...plugins.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, r]) => ({
            id: `cap:plugin:${name}`,
            label: name,
            description: [
              r.skills ? plural(r.skills, "skill") : "",
              r.agents ? plural(r.agents, "agent") : "",
              r.mcp ? plural(r.mcp, "tool") : "",
              r.on ? "" : "off",
            ]
              .filter(Boolean)
              .join(" · "),
            icon: r.on ? { id: "package" } : { id: "circle-slash" },
          })),
      },
    ],
  };
}

// ─── Agents ─────────────────────────────────────────────────────────────────

export function agentsView(p: PanelsPayload, now: number): PanelView {
  const list = p.agents.delegations;
  if (list.length === 0) {
    return { nodes: [], message: "Claude has not started a helper agent in the last 7 days." };
  }
  const counts = new Map<string, number>();
  for (const d of list) {
    const a = d.agent ?? "general-purpose";
    counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  return {
    nodes: [
      {
        id: "agents:recent",
        label: "Recent",
        description: `${list.length} · last 7 days`,
        tooltip:
          "Helper agents Claude started, newest first. Synthra sees them when Claude finishes a reply.",
        icon: { id: "history" },
        expanded: true,
        children: list.map((d, n) => {
          const agent = d.agent ?? "general-purpose";
          return {
            id: `agents:recent:${d.ts}:${n}`,
            label: clip(d.description || agent, 70),
            description: [d.description ? agent : "", d.model ?? "", relativeTime(d.ts, now)]
              .filter(Boolean)
              .join(" · "),
            tooltip: [
              d.description ?? "",
              `Agent: ${agent}`,
              d.model ? `Model: ${d.model}` : "",
              `Started ${new Date(d.ts).toLocaleString()}`,
            ]
              .filter(Boolean)
              .join("\n"),
            icon: { id: "hubot" },
          };
        }),
      },
      {
        id: "agents:most",
        label: "Most used",
        description: "last 7 days",
        icon: { id: "graph" },
        expanded: false,
        children: [...counts.entries()]
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
          .map(([agent, n]) => ({
            id: `agents:most:${agent}`,
            label: agent,
            description: plural(n, "time"),
            icon: { id: "hubot" },
          })),
      },
    ],
  };
}
