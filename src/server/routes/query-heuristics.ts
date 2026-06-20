// Shared query heuristics for the PreToolUse decision point. Used by both the
// Moat gate (Grep/Glob blocking) and the Bash observer — kept in its own module
// so neither has to import the other.

// Heuristic: does this search pattern target markup / CSS / attributes / literals
// rather than a code symbol? The graph only indexes symbols, so blocking these
// and redirecting to graph_read just forces a fallback Read. Conservative — only
// fires on syntax that never appears in a bare identifier search.
export function looksLikeNonSymbolQuery(pattern: string): boolean {
  // HTML / JSX tag: "<div", "</", "<svg"
  if (/<\/?[a-zA-Z]/.test(pattern)) return true;
  // Hyphenated attribute assignment: "data-tour=", "aria-label=" ('-' is not a
  // valid identifier char, so this is markup, not a symbol).
  if (/[a-zA-Z][\w-]*-[\w-]*\s*=/.test(pattern)) return true;
  // CSS rule / object brace: ".content{", "{ color"
  if (/\{/.test(pattern)) return true;
  // Escaped-dot class / member selector: "\.filter-bar", "\.gs"
  if (/\\\.[a-zA-Z]/.test(pattern)) return true;
  // CSS property value or units: ": 100%", "12px", "1.5rem", "50%"
  if (/:\s*\d/.test(pattern) || /\d(?:px|rem|em|vh|vw)\b/.test(pattern) || /\d%/.test(pattern)) {
    return true;
  }
  // CSS custom property: "var(--brand)", "--sidebar" — a "--" prefix is never a
  // valid code identifier, so this is styling the graph doesn't index.
  if (/--[a-zA-Z]/.test(pattern)) return true;
  // Hex color literal: "#fff", "#0a0a0a".
  if (/#[0-9a-fA-F]{3,8}\b/.test(pattern)) return true;
  // Kebab-case search ("cw-code-chip", "data-tour") — hyphens aren't valid in
  // JS/TS/Python identifiers, so it's a CSS class / HTML attribute / custom
  // element. Only treat it as non-symbol when EVERY alternation branch is kebab,
  // so a mixed query like "fetchWith429Retry|Retry-After" (real symbol + a
  // hyphenated header) still blocks. Strip regex char-classes first so a range
  // like "[a-z]" isn't mistaken for a kebab token.
  const branches = pattern
    .replace(/\[[^\]]*\]/g, "")
    .split("|")
    .map((b) => b.trim())
    .filter(Boolean);
  const isKebab = (b: string) => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/i.test(b);
  if (branches.length > 0 && branches.every(isKebab)) return true;
  return false;
}
