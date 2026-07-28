// Pure formatting + model-classification helpers, ported from the old inline
// dashboard script. Unit-tested in tests/dashboard-format.test.ts.

export type ModelFamily = "fable" | "opus" | "sonnet" | "haiku" | "unknown";

/** Abbreviate a count: 1_200_000 → "1.2M", 3_400 → "3.4k", 920 → "920". */
export function fmt(n: number): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** USD with thousands separators and 2 decimals: 1234.5 → "$1,234.50". */
export function fmtCost(usd: number): string {
  if (typeof usd !== "number" || !Number.isFinite(usd)) return "$0.00";
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Byte count for display: 0 → "0 B", 812 → "812 B", 12_698 → "12.4 KB". */
export function fmtBytes(n: number): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** ISO timestamp → "HH:MM" if today, else "Mon D". */
export function fmtTs(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Classify a raw model id into a family (drives donut + pill colors). */
export function modelFamily(model: string | undefined | null): ModelFamily {
  if (!model) return "unknown";
  const m = model.toLowerCase();
  if (m === "<synthetic>") return "unknown";
  if (m.includes("fable")) return "fable";
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return "unknown";
}

/** Strip the "claude-" prefix for display. */
export function modelLabel(model: string | undefined | null): string {
  if (!model || model === "<synthetic>") return "synthetic";
  return model.replace(/^claude-/, "");
}

/** Ellipsize a path to its last two segments: "a/b/c/d.ts" → "…/c/d.ts". */
export function shortenPath(p: string): string {
  if (!p) return "";
  const parts = p.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return parts.join("/");
  return `…/${parts.slice(-2).join("/")}`;
}

const PROJECT_HUES = [220, 75, 20, 155, 285, 330, 250, 45];

/** Stable per-project accent color (oklch), hashed from the name. */
export function projColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = PROJECT_HUES[h % PROJECT_HUES.length];
  return `oklch(72% 0.15 ${hue})`;
}
