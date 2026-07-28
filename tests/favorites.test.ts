// Favorited skills/agents stored at ~/.synthra/favorites.json. Every function
// takes an overridable path, so these tests point at a mkdtemp file rather than
// the developer's real home (same DI idiom as forgetProject in remove.test.ts).

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  favoritesPath,
  MAX_FAVORITES,
  parseFavoriteRequest,
  readFavorites,
  setFavorite,
  type FavoriteIdentity,
} from "../src/shared/favorites.js";
import { checkLocalJsonPost } from "../src/dashboard/origin-guard.js";

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "syn-fav-"));
  return join(dir, "favorites.json");
}

const SKILL: FavoriteIdentity = { kind: "skills", scope: "personal", name: "impeccable polish" };
const AGENT: FavoriteIdentity = {
  kind: "agents",
  scope: "plugin",
  source: "svelte",
  name: "svelte-file-editor",
};

describe("favoritesPath", () => {
  it("resolves under the given home, not the real one", () => {
    const p = favoritesPath("/fake/home");
    expect(p.replace(/\\/g, "/")).toBe("/fake/home/.synthra/favorites.json");
  });
});

describe("readFavorites", () => {
  it("reads a missing file as empty", async () => {
    const r = await readFavorites(await tmpFile());
    expect(r).toEqual({ schema_version: 1, favorites: [] });
  });

  it("reads corrupt JSON as empty instead of throwing", async () => {
    const p = await tmpFile();
    await writeFile(p, "{ not json", "utf8");
    expect((await readFavorites(p)).favorites).toEqual([]);
  });

  it("reads wrong-shaped files as empty", async () => {
    for (const body of ['{"favorites":"nope"}', "[]", "{}", "null"]) {
      const p = await tmpFile();
      await writeFile(p, body, "utf8");
      expect((await readFavorites(p)).favorites).toEqual([]);
    }
  });

  it("drops malformed entries but keeps valid siblings", async () => {
    const p = await tmpFile();
    await writeFile(
      p,
      JSON.stringify({
        schema_version: 1,
        favorites: [
          { kind: "skills", scope: "personal", name: "good", added_at: "x" },
          { kind: "bogus", scope: "personal", name: "bad-kind" },
          { kind: "skills", scope: "nowhere", name: "bad-scope" },
          { kind: "skills", scope: "personal", name: "   " },
          "not an object",
        ],
      }),
      "utf8",
    );
    expect((await readFavorites(p)).favorites.map((f) => f.name)).toEqual(["good"]);
  });

  it("preserves schema_version when present, defaults it when absent", async () => {
    const p = await tmpFile();
    await writeFile(p, JSON.stringify({ schema_version: 7, favorites: [] }), "utf8");
    expect((await readFavorites(p)).schema_version).toBe(7);
    const q = await tmpFile();
    await writeFile(q, JSON.stringify({ favorites: [] }), "utf8");
    expect((await readFavorites(q)).schema_version).toBe(1);
  });
});

describe("setFavorite", () => {
  it("creates the directory and writes house-format JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "syn-fav-nested-"));
    const p = join(dir, "deeper", "favorites.json"); // parent does not exist yet
    await setFavorite(SKILL, true, p);

    const raw = await readFile(p, "utf8");
    expect(raw.endsWith("}\n")).toBe(true); // trailing newline
    expect(raw).toContain('\n  "schema_version": 1'); // 2-space indent
    const entry = JSON.parse(raw).favorites[0];
    expect(entry.name).toBe("impeccable polish");
    expect(entry.source).toBeUndefined();
    expect(new Date(entry.added_at).toString()).not.toBe("Invalid Date");
  });

  it("round-trips a name containing a space without matching its prefix", async () => {
    const p = await tmpFile();
    await setFavorite(SKILL, true, p);
    const favs = (await readFavorites(p)).favorites;
    expect(favs.map((f) => f.name)).toEqual(["impeccable polish"]);
    // the pack parent is a different item
    await setFavorite({ kind: "skills", scope: "personal", name: "impeccable" }, false, p);
    expect((await readFavorites(p)).favorites).toHaveLength(1);
  });

  it("is idempotent and preserves the original added_at", async () => {
    const p = await tmpFile();
    await setFavorite(SKILL, true, p);
    const first = (await readFavorites(p)).favorites[0]?.added_at;
    await setFavorite(SKILL, true, p);
    const after = (await readFavorites(p)).favorites;
    expect(after).toHaveLength(1);
    expect(after[0]?.added_at).toBe(first);
  });

  it("removes only the matching identity", async () => {
    const p = await tmpFile();
    await setFavorite(SKILL, true, p);
    await setFavorite(AGENT, true, p);
    await setFavorite(SKILL, false, p);
    expect((await readFavorites(p)).favorites.map((f) => f.name)).toEqual(["svelte-file-editor"]);
  });

  it("treats the same name as distinct across kind, scope, and source", async () => {
    const p = await tmpFile();
    const variants: FavoriteIdentity[] = [
      { kind: "skills", scope: "personal", name: "figma-use" },
      { kind: "agents", scope: "personal", name: "figma-use" },
      { kind: "skills", scope: "project", name: "figma-use" },
      { kind: "skills", scope: "plugin", source: "figma", name: "figma-use" },
      { kind: "skills", scope: "plugin", source: "figma-mcp", name: "figma-use" },
    ];
    for (const v of variants) await setFavorite(v, true, p);
    expect((await readFavorites(p)).favorites).toHaveLength(5);
    // removing one leaves the rest
    await setFavorite(variants[0] as FavoriteIdentity, false, p);
    expect((await readFavorites(p)).favorites).toHaveLength(4);
  });

  it("keeps an unfavoriting no-op from rewriting the file", async () => {
    const p = await tmpFile();
    const r = await setFavorite(SKILL, false, p); // never favorited
    expect(r.favorites).toEqual([]);
    await expect(readFile(p, "utf8")).rejects.toThrow(); // file was never created
  });

  it("keeps stale entries for items that no longer exist", async () => {
    const p = await tmpFile();
    await setFavorite({ kind: "skills", scope: "plugin", source: "gone", name: "ghost" }, true, p);
    await setFavorite(SKILL, true, p);
    await setFavorite(SKILL, false, p);
    expect((await readFavorites(p)).favorites.map((f) => f.name)).toEqual(["ghost"]);
  });

  it("rejects mcp items", async () => {
    const p = await tmpFile();
    await expect(
      setFavorite({ kind: "mcp", scope: "project", name: "synthra" }, true, p),
    ).rejects.toThrow(/mcp/);
  });

  it("refuses to grow past MAX_FAVORITES", async () => {
    const p = await tmpFile();
    const favorites = Array.from({ length: MAX_FAVORITES }, (_, i) => ({
      kind: "skills",
      scope: "personal",
      name: `skill-${i}`,
      added_at: "2026-01-01T00:00:00.000Z",
    }));
    await writeFile(p, JSON.stringify({ schema_version: 1, favorites }), "utf8");
    await expect(setFavorite(SKILL, true, p)).rejects.toThrow(/too many/);
    // ...but toggling an existing one off still works
    await expect(
      setFavorite({ kind: "skills", scope: "personal", name: "skill-0" }, false, p),
    ).resolves.toBeTruthy();
  });

  // The reason the serialization queue exists: without it these three
  // read-modify-write cycles interleave and the last write wins, silently
  // dropping the other two hearts.
  it("keeps every entry when toggles overlap", async () => {
    const p = await tmpFile();
    await Promise.all([
      setFavorite({ kind: "skills", scope: "personal", name: "a" }, true, p),
      setFavorite({ kind: "skills", scope: "personal", name: "b" }, true, p),
      setFavorite({ kind: "agents", scope: "personal", name: "c" }, true, p),
    ]);
    expect((await readFavorites(p)).favorites.map((f) => f.name).sort()).toEqual(["a", "b", "c"]);
  });

  it("throws when the file cannot be written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "syn-fav-block-"));
    // Make the would-be parent directory a FILE, so mkdir/writeFile must fail.
    await mkdir(join(dir, "wrap"), { recursive: true });
    await writeFile(join(dir, "wrap", "favorites.json"), "x", "utf8");
    const p = join(dir, "wrap", "favorites.json", "favorites.json");
    await expect(setFavorite(SKILL, true, p)).rejects.toThrow();
  });
});

describe("parseFavoriteRequest", () => {
  const good = { kind: "skills", scope: "personal", name: "dogfood", favorite: true };

  it("accepts a well-formed body", () => {
    const r = parseFavoriteRequest(good);
    expect(r).toEqual({
      ok: true,
      id: { kind: "skills", scope: "personal", name: "dogfood" },
      favorite: true,
    });
  });

  it("normalizes empty-string and null source to absent", () => {
    for (const source of ["", null, undefined]) {
      const r = parseFavoriteRequest({ ...good, source });
      expect(r.ok && r.id.source).toBeUndefined();
    }
    const withSource = parseFavoriteRequest({ ...good, scope: "plugin", source: "figma" });
    expect(withSource.ok && withSource.id.source).toBe("figma");
  });

  it("rejects mcp — the server refuses it, not just the UI", () => {
    const r = parseFavoriteRequest({ ...good, kind: "mcp" });
    expect(r).toEqual({ ok: false, error: "kind must be skills or agents" });
  });

  it("rejects bad kind, scope, name, source, and favorite", () => {
    expect(parseFavoriteRequest({ ...good, kind: "bogus" }).ok).toBe(false);
    expect(parseFavoriteRequest({ ...good, scope: "nowhere" }).ok).toBe(false);
    expect(parseFavoriteRequest({ ...good, name: "" }).ok).toBe(false);
    expect(parseFavoriteRequest({ ...good, name: "   " }).ok).toBe(false);
    expect(parseFavoriteRequest({ ...good, name: "x".repeat(201) }).ok).toBe(false);
    expect(parseFavoriteRequest({ ...good, source: 42 }).ok).toBe(false);
    expect(parseFavoriteRequest({ ...good, source: "s".repeat(201) }).ok).toBe(false);
    expect(parseFavoriteRequest({ ...good, favorite: "yes" }).ok).toBe(false);
    expect(parseFavoriteRequest({ ...good, favorite: undefined }).ok).toBe(false);
  });

  it("rejects non-object bodies", () => {
    for (const body of [null, undefined, "string", 7, []]) {
      // an array is an object but has no valid kind, so it must still fail
      expect(parseFavoriteRequest(body).ok).toBe(false);
    }
  });

  it("ignores extra keys rather than failing", () => {
    const r = parseFavoriteRequest({ ...good, added_at: "forged", nonsense: 1 });
    expect(r.ok).toBe(true);
    expect(r.ok && "added_at" in r.id).toBe(false); // server stamps its own
  });
});

describe("checkLocalJsonPost", () => {
  it("accepts application/json, with or without a charset", () => {
    expect(checkLocalJsonPost("application/json", undefined, 8901).ok).toBe(true);
    expect(checkLocalJsonPost("application/json; charset=utf-8", undefined, 8901).ok).toBe(true);
    expect(checkLocalJsonPost("APPLICATION/JSON", undefined, 8901).ok).toBe(true);
  });

  it("rejects the content types that skip a CORS preflight", () => {
    for (const type of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data",
      undefined,
    ]) {
      const r = checkLocalJsonPost(type, undefined, 8901);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.status).toBe(415);
    }
  });

  it("accepts a same-origin Origin and rejects a foreign one", () => {
    expect(checkLocalJsonPost("application/json", "http://127.0.0.1:8901", 8901).ok).toBe(true);
    expect(checkLocalJsonPost("application/json", "http://localhost:8901", 8901).ok).toBe(true);
    const evil = checkLocalJsonPost("application/json", "http://evil.example", 8901);
    expect(evil.ok).toBe(false);
    expect(!evil.ok && evil.status).toBe(403);
    // right host, wrong port — a different local server
    expect(checkLocalJsonPost("application/json", "http://127.0.0.1:9999", 8901).ok).toBe(false);
    // unparseable
    expect(checkLocalJsonPost("application/json", "garbage", 8901).ok).toBe(false);
  });
});
