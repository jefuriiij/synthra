// The Dispatcher's brain — pure scoring of a task prompt against the installed
// Arsenal (skills + subagents) and the project's language fingerprint. Synthra
// can't dispatch subagents itself (only Claude Code's main agent can); it
// advises: "this task fits agent X on model Y, with skill Z". Conservative by
// design — a wrong route is worse than none, so nothing is recommended unless
// the top agent clears a minimum score.

import type { ArsenalData, ArsenalItem } from "../../dashboard/arsenal.js";
import { tokenizeQuery } from "../../graph/rank.js";

export interface RoutedAgent {
  name: string;
  score: number;
  reason: string;
  /** The agent's own model when its definition pins one, else "sonnet" — the
   *  execution default (5× cheaper than Opus; plan big, execute cheap). */
  model: string;
}

export interface RoutedSkill {
  name: string;
  score: number;
  reason: string;
}

export interface RouteMatch {
  confident: boolean;
  agents: RoutedAgent[];
  skills: RoutedSkill[];
}

const ROUTE_MIN_PROMPT_TOKENS = 3;
const ROUTE_MAX_AGENTS = 3;
const ROUTE_MAX_SKILLS = 2;
const FINGERPRINT_BOOST = 2;
const NAME_HIT_WEIGHT = 3;

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
}

function scoreItem(item: ArsenalItem, qTokens: Set<string>, fingerprint: Set<string>): Scored {
  const nameTokens = new Set(tokenizeQuery(item.name));
  const descTokens = new Set(tokenizeQuery(item.description));
  let score = 0;
  const hits: string[] = [];
  for (const t of qTokens) {
    if (nameTokens.has(t)) {
      score += NAME_HIT_WEIGHT;
      hits.push(t);
    } else if (descTokens.has(t)) {
      score += 1;
      hits.push(t);
    }
  }
  // Fingerprint boost: the item speaks the project's dominant language.
  for (const kw of fingerprint) {
    if (nameTokens.has(kw) || descTokens.has(kw)) {
      score += FINGERPRINT_BOOST;
      break;
    }
  }
  return { item, score, hits };
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
  const qTokens = new Set(tokenizeQuery(prompt));
  if (qTokens.size < ROUTE_MIN_PROMPT_TOKENS) {
    return { confident: false, agents: [], skills: [] };
  }
  const fingerprint = fingerprintKeywords(extCounts);

  const rank = (items: ArsenalItem[]): Scored[] =>
    items
      .filter((i) => i.enabled !== false)
      .map((i) => scoreItem(i, qTokens, fingerprint))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));

  const agents = rank(arsenal.agents)
    .slice(0, ROUTE_MAX_AGENTS)
    .map((s) => ({
      name: s.item.name,
      score: s.score,
      reason: s.hits.length ? `matches: ${s.hits.slice(0, 4).join(", ")}` : "language fit",
      model: s.item.meta?.model?.trim() || "sonnet",
    }));
  const skills = rank(arsenal.skills)
    .slice(0, ROUTE_MAX_SKILLS)
    .map((s) => ({
      name: s.item.name,
      score: s.score,
      reason: s.hits.length ? `matches: ${s.hits.slice(0, 4).join(", ")}` : "language fit",
    }));

  const confident = agents.length > 0 && (agents[0]?.score ?? 0) >= minScore;
  return { confident, agents, skills };
}

/** One compact line for the UserPromptSubmit hint. "" when not confident.
 *  ASCII-only: this string travels through PowerShell 5.1's redirected stdout
 *  (the hook path), which mangles non-ASCII into mojibake. */
export function renderHint(match: RouteMatch): string {
  if (!match.confident || match.agents.length === 0) return "";
  const a = match.agents[0] as RoutedAgent;
  const skill = match.skills[0] ? ` + skill '${match.skills[0].name}'` : "";
  return (
    `[Synthra route] This task fits agent '${a.name}' (model: ${a.model})${skill}. ` +
    `Plan here first, then delegate execution to it - execution on cheaper models cuts cost ~5x.`
  );
}

/** Verbose report for the route_task tool. Always returns something useful. */
export function renderRouteReport(task: string, match: RouteMatch): string {
  const lines = [`# route_task: "${task}"`, ""];
  if (match.agents.length === 0 && match.skills.length === 0) {
    lines.push(
      "No strong match in the installed Arsenal — proceed yourself (browse the dashboard's Arsenal tab to see what's available).",
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
  lines.push(
    "_Model policy: plan on the primary model; delegate execution to a subagent on a cheaper model (sonnet ≈ 5× cheaper than opus)._",
  );
  return lines.join("\n");
}
