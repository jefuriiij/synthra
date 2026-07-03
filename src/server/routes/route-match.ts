// The Dispatcher's brain — pure scoring of a task prompt against the installed
// Arsenal (skills + subagents) and the project's language fingerprint. Synthra
// can't dispatch subagents itself (only Claude Code's main agent can); it
// advises: "this task fits agent X on model Y, with skill Z". Conservative by
// design — a wrong route is worse than none, so nothing is recommended unless
// the top agent clears a minimum score, single generic-word matches never rank,
// and wrong-ecosystem items are penalized on fingerprinted repos.

import type { ArsenalData, ArsenalItem } from "../../dashboard/arsenal.js";
import { tokenizeQuery } from "../../graph/rank.js";

export type Difficulty = "standard" | "complex";

export interface RoutedAgent {
  name: string;
  score: number;
  reason: string;
  /** The agent's own model when its definition pins one; else "sonnet" for
   *  standard tasks (5× cheaper than Opus) or "opus" when the task scored
   *  complex — plan big, execute cheap, escalate hard. */
  model: string;
}

export interface RoutedSkill {
  name: string;
  score: number;
  reason: string;
}

export interface RouteMatch {
  confident: boolean;
  difficulty: Difficulty;
  agents: RoutedAgent[];
  skills: RoutedSkill[];
}

const ROUTE_MIN_PROMPT_TOKENS = 3;
const ROUTE_MAX_AGENTS = 3;
const ROUTE_MAX_SKILLS = 2;
const FINGERPRINT_BOOST = 2;
const WRONG_ECOSYSTEM_PENALTY = 4;
const NAME_HIT_WEIGHT = 3;

// Route-local prose stopwords — generic task-glue that made noise win (the
// field report: "add"/"new"/"app"/"across"/"without" scored real points).
// Deliberately separate from rank.ts STOPWORDS, which calibrate the Moat.
// "module" is intentionally NOT here — meaningful for HubL/HubSpot work; the
// noisy cases die via the min-signal rule + ecosystem penalty instead.
const ROUTE_STOPWORDS = new Set([
  "add",
  "adds",
  "added",
  "new",
  "app",
  "apps",
  "make",
  "makes",
  "making",
  "change",
  "changes",
  "changing",
  "create",
  "creates",
  "creating",
  "update",
  "updates",
  "updating",
  "fix",
  "fixes",
  "fixing",
  "use",
  "uses",
  "using",
  "need",
  "needs",
  "want",
  "wants",
  "work",
  "works",
  "working",
  "task",
  "tasks",
  "across",
  "without",
  "within",
  "help",
  "run",
  "runs",
  "running",
  "check",
  "checks",
  "checking",
]);

function routeTokens(text: string): string[] {
  return tokenizeQuery(text).filter((t) => !ROUTE_STOPWORDS.has(t));
}

// Signals that a task is complex enough to keep on the primary model. Crude
// keyword heuristic (v1) — a graph-informed difficulty (blast radius of the
// touched area) is the upgrade path if field reports show misses.
const HARD_SIGNALS = new Set([
  "race",
  "races",
  "concurrency",
  "concurrent",
  "deadlock",
  "leak",
  "leaks",
  "memory",
  "reconnect",
  "reconnection",
  "teardown",
  "lifecycle",
  "distributed",
  "migration",
  "migrations",
  "migrate",
  "architecture",
  "architectural",
  "refactor",
  "refactoring",
  "security",
  "vulnerability",
  "vulnerabilities",
  "audit",
  "debug",
  "debugging",
  "diagnose",
  "performance",
  "optimize",
  "optimization",
  "scalability",
  "transaction",
  "transactions",
  "consistency",
  "idempotent",
]);

/** ≥2 distinct hard signals → complex (keep it on the primary model). */
export function scoreDifficulty(prompt: string): Difficulty {
  let hits = 0;
  for (const t of new Set(tokenizeQuery(prompt))) {
    if (HARD_SIGNALS.has(t)) hits += 1;
    if (hits >= 2) return "complex";
  }
  return "standard";
}

// Conservative ext → language-keyword map for the fingerprint boost. Only
// unambiguous signals; an item mentioning the project's dominant language gets
// a small lift so "svelte agent in a svelte repo" beats a generic one.
const EXT_KEYWORDS: Record<string, string[]> = {
  ".svelte": ["svelte"],
  ".vue": ["vue"],
  ".tsx": ["react", "typescript"],
  ".jsx": ["react"],
  ".ts": ["typescript"],
  ".py": ["python"],
  ".cs": ["csharp", "dotnet"],
  ".dart": ["flutter", "dart"],
  ".rs": ["rust"],
  ".go": ["golang", "go"],
  ".java": ["java"],
  ".kt": ["kotlin"],
  ".php": ["php", "laravel"],
  ".rb": ["ruby", "rails"],
  ".hubl": ["hubspot", "hubl"],
  ".html": ["html", "css"],
};

// Ecosystem markers for the WRONG-ecosystem penalty: an item that clearly
// declares one of these, on a repo whose fingerprint contains none of the
// item's declared languages, is pushed down hard. Curated — excludes ambiguous
// English words ("go") and generic web terms ("html", "css", "typescript") so
// frontend/generalist agents aren't wrongly penalized.
const ECOSYSTEM_KEYWORDS = new Set([
  "svelte",
  "vue",
  "react",
  "angular",
  "python",
  "django",
  "flutter",
  "dart",
  "rust",
  "golang",
  "java",
  "kotlin",
  "csharp",
  "dotnet",
  "php",
  "laravel",
  "ruby",
  "rails",
  "hubspot",
  "hubl",
  "powershell",
  "swift",
]);

/** Dominant-language keywords for a project, from its graph ext tally. Only
 *  exts that make up a meaningful share (≥20%) of files contribute. */
export function fingerprintKeywords(extCounts: Map<string, number>): Set<string> {
  const total = [...extCounts.values()].reduce((a, b) => a + b, 0);
  const out = new Set<string>();
  if (total === 0) return out;
  for (const [ext, count] of extCounts) {
    if (count / total < 0.2) continue;
    for (const kw of EXT_KEYWORDS[ext] ?? []) out.add(kw);
  }
  return out;
}

interface Scored {
  item: ArsenalItem;
  score: number;
  hits: string[];
  nameHits: number;
}

function scoreItem(item: ArsenalItem, qTokens: Set<string>, fingerprint: Set<string>): Scored {
  const nameTokens = new Set(routeTokens(item.name));
  const descTokens = new Set(routeTokens(item.description));
  let score = 0;
  let nameHits = 0;
  const hits: string[] = [];
  for (const t of qTokens) {
    if (nameTokens.has(t)) {
      score += NAME_HIT_WEIGHT;
      nameHits += 1;
      hits.push(t);
    } else if (descTokens.has(t)) {
      score += 1;
      hits.push(t);
    }
  }
  // Fingerprint boost / wrong-ecosystem penalty: which ecosystems does the
  // item declare, and do any match the project's dominant language(s)?
  const declared = new Set<string>();
  for (const t of nameTokens) if (ECOSYSTEM_KEYWORDS.has(t)) declared.add(t);
  for (const t of descTokens) if (ECOSYSTEM_KEYWORDS.has(t)) declared.add(t);
  if (fingerprint.size > 0 && declared.size > 0) {
    const speaksProject = [...declared].some((kw) => fingerprint.has(kw));
    score += speaksProject ? FINGERPRINT_BOOST : -WRONG_ECOSYSTEM_PENALTY;
  } else {
    // No penalty context — keep the original gentle boost for direct mentions.
    for (const kw of fingerprint) {
      if (nameTokens.has(kw) || descTokens.has(kw)) {
        score += FINGERPRINT_BOOST;
        break;
      }
    }
  }
  return { item, score, hits, nameHits };
}

/**
 * Score a task prompt against the Arsenal. `confident` only when the prompt has
 * enough signal AND the best agent clears `minScore` — otherwise callers stay
 * silent. MCP servers are never routed (they carry no descriptions).
 */
export function scoreArsenal(
  prompt: string,
  arsenal: ArsenalData,
  extCounts: Map<string, number>,
  minScore: number,
): RouteMatch {
  const difficulty = scoreDifficulty(prompt);
  const qTokens = new Set(routeTokens(prompt));
  if (qTokens.size < ROUTE_MIN_PROMPT_TOKENS) {
    return { confident: false, difficulty, agents: [], skills: [] };
  }
  const fingerprint = fingerprintKeywords(extCounts);

  const rank = (items: ArsenalItem[]): Scored[] => {
    const scored = items
      .filter((i) => i.enabled !== false)
      .map((i) => scoreItem(i, qTokens, fingerprint))
      // Min-signal rule: a name hit, or at least two distinct token hits —
      // one generic description word is noise, not a route.
      .filter((s) => s.score > 0 && (s.nameHits > 0 || s.hits.length >= 2))
      .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
    // Dedupe by name — the same skill can be installed twice (personal copy +
    // plugin); keep the strongest.
    const seen = new Set<string>();
    return scored.filter((s) => {
      const key = s.item.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const defaultModel = difficulty === "complex" ? "opus" : "sonnet";
  const agents = rank(arsenal.agents)
    .slice(0, ROUTE_MAX_AGENTS)
    .map((s) => ({
      name: s.item.name,
      score: s.score,
      reason: s.hits.length ? `matches: ${s.hits.slice(0, 4).join(", ")}` : "language fit",
      model: s.item.meta?.model?.trim() || defaultModel,
    }));
  const skills = rank(arsenal.skills)
    .slice(0, ROUTE_MAX_SKILLS)
    .map((s) => ({
      name: s.item.name,
      score: s.score,
      reason: s.hits.length ? `matches: ${s.hits.slice(0, 4).join(", ")}` : "language fit",
    }));

  const confident = agents.length > 0 && (agents[0]?.score ?? 0) >= minScore;
  return { confident, difficulty, agents, skills };
}

/** One compact line for the UserPromptSubmit hint. "" when not confident —
 *  except on a complex verdict, which always speaks: the "stay on your primary
 *  model" advice carries no route, so it can't misroute, and staying silent
 *  exactly when the task is hardest would defeat the escalation feature.
 *  ASCII-only: this string travels through PowerShell 5.1's redirected stdout
 *  (the hook path), which mangles non-ASCII into mojibake. */
export function renderHint(match: RouteMatch): string {
  const a = match.confident ? match.agents[0] : undefined;
  if (match.difficulty === "complex") {
    if (!a) {
      return (
        "[Synthra route] Complex task - plan AND execute on your primary model; " +
        "delegate only mechanical subtasks to sonnet."
      );
    }
    const skill = match.skills[0] ? ` + skill '${match.skills[0].name}'` : "";
    return (
      `[Synthra route] Complex task - plan AND execute on your primary model, ` +
      `or delegate to '${a.name}' pinned to ${a.model}${skill}; hand only mechanical subtasks to sonnet.`
    );
  }
  if (!a) return "";
  const skill = match.skills[0] ? ` + skill '${match.skills[0].name}'` : "";
  return (
    `[Synthra route] This task fits agent '${a.name}' (model: ${a.model})${skill}. ` +
    `Plan here first, then delegate execution to it - execution on cheaper models cuts cost ~5x.`
  );
}

/** Verbose report for the route_task tool. Always returns something useful. */
export function renderRouteReport(task: string, match: RouteMatch): string {
  const lines = [`# route_task: "${task}"`, "", `Difficulty: ${match.difficulty}`, ""];
  const policy =
    match.difficulty === "complex"
      ? "_Model policy: this task scored COMPLEX — plan and execute on your primary model (opus/fable); delegate only mechanical subtasks to cheaper models._"
      : "_Model policy: standard task — plan on the primary model, delegate execution to a subagent on a cheaper model (sonnet ≈ 5× cheaper than opus)._";
  if (match.agents.length === 0 && match.skills.length === 0) {
    lines.push(
      "No strong match in the installed Arsenal — proceed yourself (browse the dashboard's Arsenal tab to see what's available).",
      "",
      policy,
    );
    return lines.join("\n");
  }
  if (match.agents.length > 0) {
    lines.push(match.confident ? "Recommended agents:" : "Possible agents (low confidence):");
    for (const a of match.agents) {
      lines.push(`- \`${a.name}\` (model: ${a.model}) — score ${a.score}, ${a.reason}`);
    }
  }
  if (match.skills.length > 0) {
    lines.push("");
    lines.push("Relevant skills:");
    for (const s of match.skills) lines.push(`- \`${s.name}\` — score ${s.score}, ${s.reason}`);
  }
  lines.push("");
  lines.push(policy);
  return lines.join("\n");
}
