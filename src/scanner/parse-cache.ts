// Incremental-scan parse cache. Stores per-file parse results keyed by content
// hash so a rescan can reuse unchanged files' symbols/imports and only re-run
// the expensive tree-sitter parse on files that actually changed.
//
// Source is NOT stored here — it's re-read at scan time to compute the hash and
// reused as ParsedFile.source, keeping the cache small (the graph holds content
// separately). Lives in .synthra-graph/ (gitignored, machine-local).
//
// BUMP PARSE_CACHE_VERSION whenever parser/extract output shape or a tree-sitter
// grammar changes — readParseCache returns an empty cache on a version mismatch,
// forcing a full re-parse so stale symbols can never leak into the graph.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { fileHash } from "./hash.js";
import { parseSource, type CallSite, type ParsedFile, type ParsedSymbol } from "./parser.js";
import type { WalkedFile } from "./walker.js";

// Bumped to 2 when call sites were added to the parse output (the calls shape
// changed) — old caches invalidate and re-parse cleanly.
export const PARSE_CACHE_VERSION = 2;

export interface CachedParse {
  hash: string;
  symbols: ParsedSymbol[];
  imports: string[];
  calls: CallSite[];
}

export interface ParseCache {
  schema_version: number;
  files: Record<string, CachedParse>;
}

export function emptyParseCache(): ParseCache {
  return { schema_version: PARSE_CACHE_VERSION, files: {} };
}

export async function readParseCache(path: string): Promise<ParseCache> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<ParseCache>;
    if (
      parsed.schema_version !== PARSE_CACHE_VERSION ||
      typeof parsed.files !== "object" ||
      parsed.files === null
    ) {
      return emptyParseCache();
    }
    return { schema_version: PARSE_CACHE_VERSION, files: parsed.files as ParseCache["files"] };
  } catch {
    return emptyParseCache();
  }
}

export async function writeParseCache(path: string, cache: ParseCache): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(cache)}\n`, "utf8");
  } catch {
    // Best-effort: a missing/unwritable cache just means the next scan is full.
  }
}

export interface IncrementalParseResult {
  parsed: ParsedFile[];
  cache: ParseCache;
  reused: number;
  reparsed: number;
  parseErrors: number;
}

/**
 * Parse `parsable` files, reusing prior results for files whose content hash is
 * unchanged. Returns the FULL ParsedFile[] (reused + freshly parsed) — so
 * `buildGraph` re-resolves every cross-file edge exactly as in a full scan —
 * plus a rebuilt cache containing only the currently-present files (deletions
 * and renames drop out naturally). Pass `full: true` to ignore the cache and
 * re-parse everything.
 */
export async function incrementalParse(
  parsable: WalkedFile[],
  prev: ParseCache,
  opts: { full?: boolean } = {},
): Promise<IncrementalParseResult> {
  const cache = emptyParseCache();
  const parsed: ParsedFile[] = [];
  let reused = 0;
  let reparsed = 0;
  let parseErrors = 0;

  for (const f of parsable) {
    let source: string;
    try {
      source = await readFile(f.absPath, "utf8");
    } catch {
      continue; // unreadable → skip, same as a failed read in parseFile
    }
    const hash = fileHash(source);

    const cached = opts.full ? undefined : prev.files[f.relPath];
    if (cached && cached.hash === hash) {
      parsed.push({
        file: f,
        source,
        symbols: cached.symbols,
        imports: cached.imports,
        calls: cached.calls,
      });
      cache.files[f.relPath] = cached;
      reused += 1;
      continue;
    }

    try {
      const p = await parseSource(f, source);
      parsed.push(p);
      cache.files[f.relPath] = { hash, symbols: p.symbols, imports: p.imports, calls: p.calls };
      reparsed += 1;
    } catch {
      // Mirror scanProject's prior behavior: a parse failure drops the file
      // from the graph (and the cache) rather than failing the whole scan.
      parseErrors += 1;
    }
  }

  return { parsed, cache, reused, reparsed, parseErrors };
}
