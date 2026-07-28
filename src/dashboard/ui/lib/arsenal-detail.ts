// Display helpers for the Arsenal detail modal. Pure on purpose, same reason as
// arsenal-groups.ts: the dashboard has no component-test harness, so logic only
// gets covered if it lives outside the .svelte file.

import { fmtBytes } from "./format";
import { itemKey } from "./arsenal-groups";
import type { ArsenalDetail, ArsenalItem, ArsenalKind } from "./types";

/** Cache key + in-flight identity for one item's detail request. */
export function detailKey(kind: ArsenalKind, item: ArsenalItem): string {
  return `${kind}|${itemKey(item)}`;
}

// The keys worth reading first, in this order; everything else follows in the
// order the frontmatter declared it.
const LEAD_KEYS = [
  "version",
  "metadata.version",
  "model",
  "tools",
  "allowed-tools",
  "argument-hint",
  "user-invocable",
  "license",
];

// The modal header already renders these as the title and the lead paragraph —
// repeating them as rows just pushes the source out of view (impeccable's
// description alone is ~1000 chars).
const HEADER_KEYS = new Set(["name", "description"]);

/** Frontmatter as ordered display rows. Empty values are dropped; keys stay
 *  verbatim so `argument-hint` renders as authored. */
export function frontmatterRows(fm: Record<string, string> | undefined): [string, string][] {
  if (!fm) return [];
  const entries = Object.entries(fm).filter(
    ([k, v]) => (v ?? "").trim().length > 0 && !HEADER_KEYS.has(k),
  );
  const lead: [string, string][] = [];
  for (const key of LEAD_KEYS) {
    const hit = entries.find(([k]) => k === key);
    if (hit) lead.push(hit);
  }
  const rest = entries.filter(([k]) => !LEAD_KEYS.includes(k));
  return [...lead, ...rest];
}

/**
 * The key/value rows to show above the source. Frontmatter when the item has a
 * file; otherwise its `meta` — which for an MCP entry (type, url) is the only
 * content there is, and used to be visible on the expanding card.
 */
export function detailRows(detail: ArsenalDetail | null | undefined): [string, string][] {
  if (!detail) return [];
  const fm = frontmatterRows(detail.frontmatter);
  if (fm.length) return fm;
  return Object.entries(detail.meta ?? {}).filter(([, v]) => (v ?? "").trim().length > 0);
}

/** One-line provenance under the title: where it came from, what it is, how
 *  big, and the file it reads from. */
export function detailSubtitle(item: ArsenalItem, detail?: ArsenalDetail | null): string {
  const kindWord = { skills: "skill", agents: "agent", mcp: "mcp server" };
  const origin = item.pack
    ? item.pack
    : item.scope === "plugin"
      ? `plugin ${item.source ?? ""}`.trim()
      : item.scope;
  const parts = [origin];
  if (detail) {
    parts.push(kindWord[detail.kind]);
    if (detail.body_chars) parts.push(fmtBytes(detail.body_chars));
    if (detail.path) parts.push(detail.path);
  }
  return parts.filter(Boolean).join(" · ");
}

/** Line/char counts for the body header chip. CRLF-safe; a single trailing
 *  newline does not count as an extra line. */
export function bodyStats(body: string | undefined): { lines: number; chars: number } {
  if (!body) return { lines: 0, chars: 0 };
  const normal = body.replace(/\r\n/g, "\n").replace(/\n$/, "");
  if (!normal) return { lines: 0, chars: body.length };
  return { lines: normal.split("\n").length, chars: body.length };
}
