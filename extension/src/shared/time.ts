// Small text helpers shared by the sidebar trees (host) and the large panel
// (webview). No imports at all: the webview bundle runs in a browser.

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", then a date.
 *  Takes an ISO string or epoch ms; "" when it can't be read. */
export function relativeTime(at: string | number, now: number): string {
  const ms = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(ms)) return "";
  const min = Math.floor((now - ms) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.floor(h / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

/** "1 skill", "3 skills". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Cut to `n` characters, with an ellipsis when it was longer. */
export const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** The first line that has text in it, trimmed. */
export const firstLine = (s: string) =>
  s
    .split(/\r?\n/)
    .find((l) => l.trim())
    ?.trim() ?? "";
