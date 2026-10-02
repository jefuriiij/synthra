// The large Synthra panel's tabs, built from GET /panels. Pure — no `vscode`
// import — so the main test suite checks it like panelTrees.ts. Returns the
// view the webview renders, and what each of its keys opens: the host opens
// only those (see shared/tabs.ts).

import { homedir } from "node:os";
import { basename, join } from "node:path";

import {
  curatorSummary,
  eventTarget,
  MEMORY_KINDS,
  type PanelItem,
  type PanelsPayload,
  type PanelTarget,
  proposalDiff,
} from "./panelTrees";
import { plural } from "./shared/time";
import type {
  AgentsTab,
  CapabilitiesTab,
  CapabilityRow,
  KnowledgeCard,
  LearningTab,
  MemoryNote,
  MemorySection,
  MemoryTab,
  PluginRow,
  SettingsTab,
  TabsView,
} from "./shared/tabs";

export interface BuiltTabs {
  view: TabsView;
  targets: Map<string, PanelTarget>;
}

/** Keys are handed out in order: "k0", "k1", … — meaningless outside the
 *  view they came with. */
class Keys {
  readonly targets = new Map<string, PanelTarget>();
  open(path: string): string {
    return this.target({ kind: "file", path });
  }
  target(t: PanelTarget): string {
    const key = `k${this.targets.size}`;
    this.targets.set(key, t);
    return key;
  }
}

const ms = (iso: string): number | undefined => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
};

/** Nothing to show but a line of text: not running, too old, no answer. */
export function messageTabs(folder: string, message: string): BuiltTabs {
  return { view: { project: basename(folder), message }, targets: new Map() };
}

export function buildTabs(folder: string, p: PanelsPayload, now = Date.now()): BuiltTabs {
  const keys = new Keys();
  return {
    view: {
      project: basename(folder),
      ...(p.learning ? { learning: learningTab(p.learning, keys, now) } : {}),
      memory: memoryTab(p, keys),
      capabilities: capabilitiesTab(p, keys),
      agents: agentsTab(p),
      ...(p.settings ? { settings: settingsTab(p.settings) } : {}),
    },
    targets: keys.targets,
  };
}

// ─── Memory ─────────────────────────────────────────────────────────────────

const CARDS = {
  project: {
    title: "Project memory",
    shownPath: ".synthra/MEMORY.md",
    hint: "What every AI should know about this project. Loaded at the start of every session, shared with the team in git, and read by other AI tools through AGENTS.md.",
  },
  user: {
    title: "About you",
    shownPath: "~/.synthra/USER.md",
    hint: "What AIs should know about you. Loaded in every project. Private to this computer.",
  },
} as const;

function knowledgeCards(p: PanelsPayload, keys: Keys): KnowledgeCard[] {
  const f = p.memory.files;
  if (!f) return [];
  return (["project", "user"] as const).map((t) => ({
    target: t,
    ...CARDS[t],
    exists: f[t].exists,
    entries: f[t].entries,
    chars: f[t].chars,
    limit: f[t].limit,
    ...(f[t].exists ? { key: keys.open(f[t].path) } : {}),
  }));
}

function memoryTab(p: PanelsPayload, keys: Keys): MemoryTab {
  const m = p.memory;
  const files = knowledgeCards(p, keys);
  if (m.unreadable) {
    return {
      branch: m.branch,
      total: 0,
      stale: 0,
      unreadable: m.unreadable,
      ...(m.store_path ? { store: keys.open(m.store_path) } : {}),
      files,
      sections: [],
    };
  }

  // Store order is save order: the index is a stable id, the last is newest.
  const notes = m.entries.map((e, i) => ({ e, i }));
  const note = ({ e, i }: (typeof notes)[number]): MemoryNote => {
    const at = ms(e.date);
    return {
      id: `mem:${i}`,
      text: e.content,
      ...(at !== undefined ? { at } : {}),
      tags: e.tags,
      files: e.files.map((f) => ({ path: f, key: keys.open(join(p.project_root, f)) })),
      stale: e.stale,
    };
  };

  const sections: MemorySection[] = [];
  let earlier: MemoryNote[] = [];
  for (const k of MEMORY_KINDS) {
    const list = notes.filter((x) => x.e.kind === k.kind).reverse();
    const [newest, ...older] = list;
    if (!newest) continue;
    if (k.kind === "task") {
      // Only the newest task is current, as in CONTEXT.md and the sidebar.
      sections.push({
        kind: "task",
        label: k.label,
        hint: k.tooltip,
        folded: false,
        notes: [note(newest)],
      });
      earlier = older.map(note);
      continue;
    }
    sections.push({
      kind: k.kind,
      label: k.label,
      hint: k.tooltip,
      folded: false,
      notes: list.map(note),
    });
  }
  if (earlier.length > 0) {
    sections.push({
      kind: "earlier",
      label: "Earlier tasks",
      hint: "Tasks saved before the current one, newest first.",
      folded: true,
      notes: earlier,
    });
  }

  return {
    branch: m.branch,
    total: m.entries.length,
    stale: m.entries.filter((e) => e.stale.length > 0).length,
    ...(m.entries.length > 0 ? { contextMd: keys.open(m.context_md_path) } : {}),
    files,
    sections,
  };
}

// ─── Capabilities ───────────────────────────────────────────────────────────

const GROUP: Record<PanelItem["scope"], string> = {
  project: "This project",
  personal: "Yours",
  plugin: "Plugins",
};

function capabilitiesTab(p: PanelsPayload, keys: Keys): CapabilitiesTab {
  const c = p.capabilities;
  if (c.error) return { error: c.error, skills: [], agents: [], mcp: [], plugins: [] };

  const row = (kind: "skills" | "agents" | "mcp", i: PanelItem): CapabilityRow => {
    const extra =
      kind === "skills"
        ? i.commands
          ? plural(i.commands, "command")
          : undefined
        : kind === "agents"
          ? i.meta?.model
          : i.meta?.type;
    return {
      id: `${kind}:${i.scope}:${i.source ?? ""}:${i.name}`,
      name: i.name,
      description: i.description,
      scope: i.scope,
      group: i.scope === "plugin" ? (i.source ?? GROUP.plugin) : GROUP[i.scope],
      ...(extra ? { extra } : {}),
      off: i.enabled === false,
      ...(i.file ? { key: keys.open(i.file) } : {}),
    };
  };

  const plugins = new Map<string, PluginRow>();
  for (const [kind, list] of [
    ["skills", c.skills],
    ["agents", c.agents],
    ["mcp", c.mcp],
  ] as const) {
    for (const i of list) {
      if (i.scope !== "plugin" || !i.source) continue;
      const r = plugins.get(i.source) ?? {
        name: i.source,
        skills: 0,
        agents: 0,
        mcp: 0,
        off: false,
      };
      r[kind] += 1;
      if (i.enabled === false) r.off = true;
      plugins.set(i.source, r);
    }
  }

  return {
    skills: c.skills.map((i) => row("skills", i)),
    agents: c.agents.map((i) => row("agents", i)),
    mcp: c.mcp.map((i) => row("mcp", i)),
    plugins: [...plugins.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
}

// ─── Agents ─────────────────────────────────────────────────────────────────

function agentsTab(p: PanelsPayload): AgentsTab {
  const counts = new Map<string, number>();
  const recent = p.agents.delegations.flatMap((d, n) => {
    const at = ms(d.ts);
    if (at === undefined) return [];
    const agent = d.agent ?? "general-purpose";
    counts.set(agent, (counts.get(agent) ?? 0) + 1);
    return [
      {
        id: `agent:${d.ts}:${n}`,
        title: d.description || agent,
        agent,
        ...(d.model ? { model: d.model } : {}),
        at,
      },
    ];
  });
  return {
    recent,
    most: [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([agent, count]) => ({ agent, count })),
  };
}

// ─── Settings ───────────────────────────────────────────────────────────────

function settingsTab(s: NonNullable<PanelsPayload["settings"]>): SettingsTab {
  const groups: SettingsTab["groups"] = [];
  for (const row of s.settings) {
    let g = groups.find((x) => x.name === row.group);
    if (!g) {
      g = { name: row.group, rows: [] };
      groups.push(g);
    }
    g.rows.push({ ...row });
  }
  return { path: tildify(s.path), groups };
}

/** `/home/me/.synthra/settings.json` → `~/.synthra/settings.json`, for display. */
export function tildify(path: string, home: string = homedir()): string {
  const h = home.replace(/[\\/]+$/, "");
  return h && (path === h || path.startsWith(`${h}/`) || path.startsWith(`${h}\\`))
    ? `~${path.slice(h.length)}`
    : path;
}

// ─── Learning ───────────────────────────────────────────────────────────────

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function learningTab(
  l: NonNullable<PanelsPayload["learning"]>,
  keys: Keys,
  now: number,
): LearningTab {
  const week = l.recent.filter((e) => now - Date.parse(e.ts) < WEEK_MS && e.action !== "reject");
  const created = new Set(week.filter((e) => e.action === "create").map((e) => e.path));
  // Improved = patched or rewritten. A Curator archive or a restore is not an
  // improvement.
  const improved = new Set(
    week
      .filter((e) => (e.action === "patch" || e.action === "edit") && !created.has(e.path))
      .map((e) => e.path),
  );
  return {
    approval: l.approval,
    newThisWeek: created.size,
    improvedThisWeek: improved.size,
    pending: l.pending.map((x) => ({
      id: x.id,
      action: x.action,
      name: x.name,
      scope: x.scope,
      description: x.description,
      ...(x.reason ? { reason: x.reason } : {}),
      at: ms(x.ts) ?? now,
      stale: x.stale,
      diff: keys.target(proposalDiff(x)),
    })),
    recent: l.recent.map((e) => {
      const t = eventTarget(e, now);
      return {
        id: `${e.id}:${e.action}`,
        action: e.action,
        actor: e.actor,
        name: e.name,
        scope: e.scope,
        approved: e.approved === true,
        ...(e.reason ? { reason: e.reason } : {}),
        at: ms(e.ts) ?? now,
        ...(t ? { key: keys.target(t) } : {}),
      };
    }),
    learned: l.learned.map((s) => ({
      name: s.name,
      scope: s.scope,
      description: s.description,
      ...(s.origin ? { origin: s.origin } : {}),
      key: keys.open(s.path),
    })),
    ...(l.curator ? { curator: curatorCard(l.curator, keys, now) } : {}),
  };
}

function curatorCard(
  c: NonNullable<NonNullable<PanelsPayload["learning"]>["curator"]>,
  keys: Keys,
  now: number,
): NonNullable<LearningTab["curator"]> {
  const next = c.nextRunAt ? ms(c.nextRunAt) : undefined;
  return {
    enabled: c.enabled,
    lastRun: curatorSummary(c, now),
    ...(next !== undefined ? { nextRunAt: next } : {}),
    staleDays: c.staleDays,
    archiveDays: c.archiveDays,
    stale: c.stale.map((s) => ({
      name: s.name,
      scope: s.scope,
      daysUnused: s.daysUnused,
      path: s.path,
      key: keys.open(s.path),
    })),
    archived: c.archived.map((a) => ({
      name: a.name,
      scope: a.scope,
      at: ms(a.archivedAt) ?? now,
      archivePath: a.archivePath,
      key: keys.open(join(a.archivePath, "SKILL.md")),
    })),
    pinned: c.pinned.map((p) => ({
      name: p.name,
      scope: p.scope,
      path: p.path,
      key: keys.open(p.path),
    })),
  };
}
