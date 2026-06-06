// `syn scan [path]` — bootstrap then walk + parse + write graph.
// Also invoked by the default `syn .` flow (M3 will chain start-claude after).

import { resolve } from "node:path";

import { buildGraph, buildSymbolIndex } from "../scanner/extract.js";
import { parseFile, type ParsedFile } from "../scanner/parser.js";
import { walk, type WalkedFile } from "../scanner/walker.js";
import { writeGraph, writeSymbolIndex } from "../graph/store.js";
import { log } from "../shared/logger.js";
import { resolvePaths } from "../shared/paths.js";
import { bootstrap } from "./bootstrap.js";

const PARSABLE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".cts",
  ".mts",
  ".js",
  ".jsx",
  ".cjs",
  ".mjs",
  ".py",
  ".pyi",
  ".svelte",
  ".vue",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".php",
  ".rb",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
  ".hh",
  ".hxx",
  ".dart",
  ".cs",
]);

export interface ScanResult {
  walked: number;
  parsed: number;
  symbolCount: number;
  edgeCount: number;
  durationMs: number;
}

export interface ScanOptions {
  /** Suppress per-step log output (used for branch-switch rescans). */
  silent?: boolean;
}

/**
 * Core scan pipeline — bootstrap + walk + parse + write graph. Importable
 * from anywhere (server, CLI, tests). `scanCommand` is just a logging wrapper
 * around this. Pass `silent: true` to skip the chatty progress output.
 */
export async function scanProject(
  projectRootRaw: string,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const projectRoot = resolve(projectRootRaw);
  const paths = resolvePaths(projectRoot);
  const start = Date.now();
  const verbose = !opts.silent;

  if (verbose) log.info(`scanning ${projectRoot}`);

  const boot = await bootstrap(paths);
  if (verbose) {
    if (boot.graphCreated) log.info("  created .synthra-graph/");
    if (boot.contextCreated) log.info("  created .synthra/");
    if (boot.gitignoreUpdated) log.info("  updated .gitignore");
    if (boot.claudeMdCreated) {
      log.info("  created CLAUDE.md — onboarding skeleton for the agent");
      log.info(
        "    ↳ fill in Build / Conventions / Decisions (or run /init in Claude to auto-draft)",
      );
    } else if (boot.claudeMdUpdated) {
      log.info("  updated CLAUDE.md");
    }
  }

  const walked: WalkedFile[] = [];
  for await (const file of walk(projectRoot)) walked.push(file);
  if (verbose) log.info(`  walked ${walked.length} files`);

  const parsable = walked.filter((f) => PARSABLE_EXTS.has(f.ext));
  const parsed: ParsedFile[] = [];
  let parseErrors = 0;
  for (const file of parsable) {
    try {
      parsed.push(await parseFile(file));
    } catch (err) {
      parseErrors += 1;
      if (verbose) log.debug(`    parse failed: ${file.relPath} — ${(err as Error).message}`);
    }
  }
  if (verbose) {
    log.info(
      `  parsed ${parsed.length} files (${walked.length - parsable.length} skipped` +
        (parseErrors ? `, ${parseErrors} errored` : "") +
        ")",
    );
  }

  const graph = await buildGraph(projectRoot, parsed);
  const symbolIndex = buildSymbolIndex(graph);

  await writeGraph(paths.infoGraph, graph);
  await writeSymbolIndex(paths.symbolIndex, symbolIndex);

  if (verbose) {
    log.info(
      `  wrote ${paths.infoGraph} — ${graph.symbol_count} symbols, ${graph.edge_count} edges`,
    );
    log.info(`  wrote ${paths.symbolIndex} — ${Object.keys(symbolIndex).length} names`);
  }

  const durationMs = Date.now() - start;
  if (verbose) log.info(`done in ${(durationMs / 1000).toFixed(2)}s`);

  return {
    walked: walked.length,
    parsed: parsed.length,
    symbolCount: graph.symbol_count,
    edgeCount: graph.edge_count,
    durationMs,
  };
}

// Thin alias so the CLI command keeps its current name. Drop in v0.2 if we
// settle on a single public function.
export async function scanCommand(rawPath: string): Promise<ScanResult> {
  return scanProject(rawPath);
}
