// Per-file keyword extraction. Used for query-time relevance ranking.
// Tokenizes identifiers + comment words, splits camelCase/snake_case, filters
// stopwords, and returns the top-N rare tokens scored by inverse frequency
// against a small built-in english/code corpus.

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "do", "for", "from",
  "has", "have", "he", "if", "in", "is", "it", "its", "not", "of", "on", "or",
  "she", "that", "the", "they", "this", "to", "was", "we", "were", "will", "with",
  "you", "your", "i", "me", "my", "our", "us", "their", "them", "his", "her",
  // common code words that add no signal
  "function", "const", "let", "var", "class", "interface", "type", "enum",
  "import", "export", "from", "default", "return", "if", "else", "for", "while",
  "do", "switch", "case", "break", "continue", "new", "this", "super", "throw",
  "try", "catch", "finally", "async", "await", "yield", "true", "false", "null",
  "undefined", "void", "any", "string", "number", "boolean", "object", "array",
  "self", "cls", "def", "lambda", "pass", "raise", "with", "as", "in",
  "todo", "fixme", "note",
]);

const COMMON_CODE = new Set([
  "value", "data", "result", "args", "kwargs", "options", "config", "params",
  "name", "id", "key", "index", "item", "items", "list", "map", "set", "get",
  "set", "add", "remove", "delete", "create", "update", "find", "fetch", "load",
  "save", "init", "main", "run", "start", "stop", "test", "check", "validate",
  "error", "err", "warn", "info", "debug", "log", "trace", "msg", "message",
  "path", "file", "dir", "url", "host", "port", "size", "length", "count",
  "input", "output", "source", "target", "callback", "handler", "listener",
  "props", "state", "context", "render", "component", "node", "tree", "root",
]);

// Frequency weight — common-code words count for less than rare identifiers
function score(token: string): number {
  if (STOPWORDS.has(token)) return 0;
  if (COMMON_CODE.has(token)) return 0.2;
  if (token.length <= 2) return 0.1;
  return 1;
}

function splitIdentifier(id: string): string[] {
  // snake_case + kebab-case → words
  const partsRaw = id.split(/[_\-./]+/).filter(Boolean);
  const out: string[] = [];
  for (const part of partsRaw) {
    // camelCase / PascalCase → words. Handles "XMLHttp" → ["XML", "Http"]
    const camelParts = part.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g);
    if (camelParts) out.push(...camelParts);
    else out.push(part);
  }
  return out.map((w) => w.toLowerCase()).filter((w) => /[a-z]/.test(w));
}

export function extractKeywords(content: string, _ext: string): string[] {
  // Identifiers + alphanumeric words. Picks up both code and comment text.
  const tokens = content.match(/[A-Za-z_][A-Za-z0-9_]{1,40}/g) ?? [];
  const counts = new Map<string, number>();
  for (const tok of tokens) {
    for (const word of splitIdentifier(tok)) {
      const w = score(word);
      if (w === 0) continue;
      counts.set(word, (counts.get(word) ?? 0) + w);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 32)
    .map(([w]) => w);
}
