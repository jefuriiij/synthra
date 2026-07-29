// Favorited skills and agents, for the dashboard's Arsenal browser.
//
// Stored at ~/.synthra/favorites.json — machine-wide, not per-project, because
// skills and agents themselves are machine-wide (personal + plugin scoped). A
// per-project file would fragment one list across every registered project.
//
// Browsing only: nothing in the routing path reads this. The Dispatcher scores
// what's installed, not what you've bookmarked, so favoriting can never change
// which agent Claude gets pointed at.
//
// NOTE ON THE `path` PARAMETERS: every function takes an overridable path and
// `favoritesPath()` is a FUNCTION, not a module-scope const computed from
// homedir() at import time. project-registry.ts used to do the latter, which is
// why four of its five exports had no coverage and why forgetProject had to
// re-implement read+write inline to escape the closure. It follows this shape
// now; keep both that way.

import { homedir } from "node:os";
import { join } from "node:path";

import {
  type ArsenalKind,
  type ArsenalScope,
  isArsenalKind,
  isArsenalScope,
} from "../dashboard/arsenal.js";
import { readJsonFile, updateJsonFile } from "./json-store.js";

const SCHEMA_VERSION = 1;
/** Bound on the file's size. The endpoint is unauthenticated (localhost) and
 *  entries are never pruned, so without a cap a forged POST loop could grow
 *  this file without limit. 2000 entries is ~800 KB and far beyond real use. */
const MAX_FAVORITES = 2000;
const NAME_MAX = 200;

/** MCP servers are config entries, not files, and carry nothing worth
 *  bookmarking — they're excluded at the write boundary, not just in the UI. */
export type FavoriteKind = Exclude<ArsenalKind, "mcp">;

/** Identity of one favorited item — the same tuple /arsenal/item validates. */
export interface FavoriteIdentity {
  kind: ArsenalKind;
  scope: ArsenalScope;
  source?: string;
  name: string;
}

export interface FavoriteEntry extends FavoriteIdentity {
  /** ISO timestamp, stamped server-side — never read from a request body. */
  added_at: string;
}

export interface FavoritesFile {
  schema_version: number;
  favorites: FavoriteEntry[];
}

/** `~/.synthra/favorites.json`. A function so tests can point at a temp home. */
export function favoritesPath(homeDir = homedir()): string {
  return join(homeDir, ".synthra", "favorites.json");
}

function emptyFile(): FavoritesFile {
  return { schema_version: SCHEMA_VERSION, favorites: [] };
}

function validEntry(raw: unknown): FavoriteEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (!isArsenalKind(e.kind) || !isArsenalScope(e.scope)) return null;
  if (typeof e.name !== "string" || !e.name.trim()) return null;
  return {
    kind: e.kind,
    scope: e.scope,
    ...(typeof e.source === "string" && e.source ? { source: e.source } : {}),
    name: e.name,
    added_at: typeof e.added_at === "string" ? e.added_at : "",
  };
}

/**
 * Read the file. A missing, unreadable, corrupt, or wrong-shaped file reads as
 * empty — first run is the common case and must not be an error. Individual
 * malformed entries are dropped while their valid siblings survive, so one bad
 * hand-edit doesn't wipe the list.
 */
export async function readFavorites(path = favoritesPath()): Promise<FavoritesFile> {
  const read = await readJsonFile<Partial<FavoritesFile>>(path);
  // A damaged file still reads as empty HERE, because this is the display path
  // and hearts are not worth an error dialog. What changed is that setFavorite
  // no longer writes over it — see below.
  if (read.status !== "ok" || !Array.isArray(read.data.favorites)) return emptyFile();
  return {
    schema_version:
      typeof read.data.schema_version === "number" ? read.data.schema_version : SCHEMA_VERSION,
    favorites: read.data.favorites.map(validEntry).filter((e): e is FavoriteEntry => e !== null),
  };
}

function sameIdentity(a: FavoriteIdentity, b: FavoriteIdentity): boolean {
  return (
    a.kind === b.kind &&
    a.scope === b.scope &&
    (a.source ?? "") === (b.source ?? "") &&
    a.name === b.name
  );
}

/**
 * Add or remove one favorite. Idempotent: setting an existing favorite `true`
 * again is a no-op that preserves its original `added_at`.
 *
 * Unlike the rest of Synthra's home-dir writes this THROWS on write failure —
 * a heart is user-initiated and visually confirmed, so swallowing the error
 * would leave the UI asserting something that isn't on disk. The caller turns
 * that into a 500 and the client un-fills the heart.
 */
export async function setFavorite(
  id: FavoriteIdentity,
  favorite: boolean,
  path = favoritesPath(),
): Promise<{ favorite: boolean; favorites: FavoriteEntry[] }> {
  if (id.kind === "mcp") throw new Error("mcp items cannot be favorited");

  let latest: FavoriteEntry[] = [];
  const result = await updateJsonFile<FavoritesFile>(path, emptyFile, (file) => {
    const favorites = Array.isArray(file.favorites)
      ? file.favorites.map(validEntry).filter((e): e is FavoriteEntry => e !== null)
      : [];
    const at = favorites.findIndex((e) => sameIdentity(e, id));

    if (favorite && at === -1) {
      if (favorites.length >= MAX_FAVORITES) throw new Error("too many favorites");
      favorites.push({
        kind: id.kind,
        scope: id.scope,
        ...(id.source ? { source: id.source } : {}),
        name: id.name,
        added_at: new Date().toISOString(),
      });
    } else if (!favorite && at !== -1) {
      favorites.splice(at, 1);
    } else {
      // Already in the requested state — don't rewrite the file for a no-op.
      latest = favorites;
      return null;
    }

    latest = favorites;
    return { schema_version: file.schema_version ?? SCHEMA_VERSION, favorites };
  });

  // Throwing surfaces as a 500 and the client un-fills the heart, which is the
  // right outcome: silently "succeeding" against a file we refused to write
  // would leave the UI asserting something that isn't on disk.
  if (result.status === "corrupt") {
    throw new Error(
      `favorites file could not be parsed (${result.error})` +
        (result.quarantined ? `; a copy is at ${result.quarantined}` : ""),
    );
  }
  return { favorite, favorites: latest };
}

/**
 * Narrow an untrusted request body. Returns an error string instead of throwing
 * so the route picks the status code. This is the single place MCP is rejected,
 * which makes "the server refuses it" a testable fact rather than a UI habit.
 */
export function parseFavoriteRequest(
  body: unknown,
): { ok: true; id: FavoriteIdentity; favorite: boolean } | { ok: false; error: string } {
  if (!body || typeof body !== "object")
    return { ok: false, error: "a JSON object body is required" };
  const b = body as Record<string, unknown>;

  if (!isArsenalKind(b.kind) || b.kind === "mcp") {
    return { ok: false, error: "kind must be skills or agents" };
  }
  if (!isArsenalScope(b.scope)) {
    return { ok: false, error: "scope must be project, personal or plugin" };
  }
  if (typeof b.name !== "string" || !b.name.trim() || b.name.length > NAME_MAX) {
    return { ok: false, error: "name is required" };
  }
  if (b.source !== undefined && b.source !== null && typeof b.source !== "string") {
    return { ok: false, error: "source must be a string" };
  }
  if (typeof b.source === "string" && b.source.length > NAME_MAX) {
    return { ok: false, error: "source is too long" };
  }
  if (typeof b.favorite !== "boolean") {
    return { ok: false, error: "favorite must be a boolean" };
  }

  // "" and null both mean "not from a plugin", matching ArsenalItem.
  const source = typeof b.source === "string" && b.source ? b.source : undefined;
  return {
    ok: true,
    id: { kind: b.kind, scope: b.scope, ...(source ? { source } : {}), name: b.name },
    favorite: b.favorite,
  };
}

export { MAX_FAVORITES, NAME_MAX, SCHEMA_VERSION };
