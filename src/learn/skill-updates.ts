// Updates for the skills installed with `npx skills`, checked the way that
// tool checks them: its lock file (~/.agents/.skill-lock.json) keeps the git
// tree hash of each skill's folder at install time, and GitHub's tree API
// gives the folder's hash now. One request per source repo, not per skill.
//
// Synthra only checks, shows what changed, and keeps a "don't update" list.
// The update itself is `npx skills update <names> -g -y`, run by the IDE in a
// terminal: that tool rewrites the lock and every agent's copy, so it stays
// the only writer of what it installed. A skill not in the lock (impeccable,
// your own, Synthra's) is never offered an update.
//
// State in ~/.synthra/skills: updates.json (the last check) and holds.json
// (the skills never to offer). A check result only says "update" while the
// lock still has the hash the check saw, so a finished update clears itself.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { readJsonFile, writeJsonAtomic } from "../shared/json-store.js";
import type { SynthraPaths } from "../shared/paths.js";
import { findSkill, skillLockPath } from "./skills.js";

/** One skill of the lock file that can be checked against GitHub. */
export interface LockEntry {
  name: string;
  /** "owner/repo". */
  source: string;
  /** "skills/x/SKILL.md", in the repo. */
  skillPath: string;
  /** The folder's git tree hash at install time. */
  folderHash: string;
  /** A branch or tag it was installed from; unset = the default branch. */
  ref?: string;
}

interface RawLock {
  skills?: Record<
    string,
    | {
        source?: unknown;
        sourceType?: unknown;
        skillPath?: unknown;
        skillFolderHash?: unknown;
        ref?: unknown;
      }
    | undefined
  >;
}

export const SOURCE_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const REF_RE = /^[A-Za-z0-9._/-]{1,100}$/;

/** The GitHub skills of a lock file (others can't be checked this way). */
export async function readLockEntries(lockPath: string): Promise<LockEntry[]> {
  const r = await readJsonFile<RawLock>(lockPath);
  const skills = r.status === "ok" ? r.data?.skills : undefined;
  if (!skills || typeof skills !== "object") return [];
  const out: LockEntry[] = [];
  for (const [name, e] of Object.entries(skills)) {
    if (!e || !SKILL_NAME_RE.test(name)) continue;
    const { source, sourceType, skillPath, skillFolderHash, ref } = e;
    if (sourceType !== "github" || typeof source !== "string" || !SOURCE_RE.test(source)) continue;
    if (typeof skillPath !== "string" || !skillPath.endsWith("SKILL.md")) continue;
    if (typeof skillFolderHash !== "string" || !SHA_RE.test(skillFolderHash)) continue;
    out.push({
      name,
      source,
      skillPath,
      folderHash: skillFolderHash,
      ...(typeof ref === "string" && REF_RE.test(ref) ? { ref } : {}),
    });
  }
  return out;
}

/** "skills/x/SKILL.md" → "skills/x"; a SKILL.md at the root → "". */
export function folderOf(skillPath: string): string {
  const p = skillPath.replace(/\\/g, "/");
  return p === "SKILL.md" ? "" : p.slice(0, -"/SKILL.md".length);
}

// ─── the last check ─────────────────────────────────────────────────────────

export interface UpdateCheck {
  checkedAt: string;
  /** Per skill: the lock's hash when checked, and the hash on GitHub. `latest`
   *  null = its folder isn't in its repo any more (moved or removed). */
  skills: Record<string, { installed: string; latest: string | null; branch: string }>;
  /** Sources that couldn't be checked, with why. */
  errors: Record<string, string>;
}

const checkFile = (state: string) => join(state, "updates.json");
const holdsFile = (state: string) => join(state, "holds.json");

export async function readCheck(state: string): Promise<UpdateCheck | null> {
  const r = await readJsonFile<UpdateCheck>(checkFile(state));
  if (r.status !== "ok" || !r.data || typeof r.data.skills !== "object") return null;
  return {
    checkedAt: String(r.data.checkedAt ?? ""),
    skills: r.data.skills,
    errors: r.data.errors ?? {},
  };
}

export async function readHolds(state: string): Promise<Set<string>> {
  const r = await readJsonFile<{ held?: unknown }>(holdsFile(state));
  const list = r.status === "ok" && Array.isArray(r.data?.held) ? r.data.held : [];
  return new Set(list.filter((x): x is string => typeof x === "string"));
}

/** Never offer an update for this skill (on), or offer them again (off). */
export async function setHold(state: string, name: string, on: boolean): Promise<void> {
  const held = await readHolds(state);
  if (on) held.add(name);
  else held.delete(name);
  await mkdir(state, { recursive: true });
  await writeJsonAtomic(holdsFile(state), { held: [...held].sort() });
}

/** One line per reason: "<why> (a/b, c/d)", not the same sentence per repo. */
export function groupErrors(errors: Record<string, string>): string[] {
  const by = new Map<string, string[]>();
  for (const [source, why] of Object.entries(errors)) by.set(why, [...(by.get(why) ?? []), source]);
  return [...by].map(([why, sources]) => `${why} (${sources.join(", ")})`);
}

export type UpdateState = "available" | "moved";

/** What the Capabilities tab shows per installed skill, from the last check
 *  and the lock as it is now. */
export interface UpdateFacts {
  checkedAt?: string;
  errors: string[];
  /** Skill name → its state; only skills with something to say. */
  state: Map<string, UpdateState>;
  held: Set<string>;
}

export async function updateFacts(paths: SynthraPaths): Promise<UpdateFacts> {
  const state = paths.skillState;
  const [check, held, lock] = await Promise.all([
    readCheck(state),
    readHolds(state),
    readLockEntries(skillLockPath(paths, "global")),
  ]);
  const out: UpdateFacts = { errors: [], state: new Map(), held };
  if (!check) return out;
  out.checkedAt = check.checkedAt;
  out.errors = groupErrors(check.errors);
  for (const e of lock) {
    const c = check.skills[e.name];
    // Updated (or reinstalled) since the check: the lock moved on.
    if (!c || c.installed !== e.folderHash) continue;
    if (c.latest === null) out.state.set(e.name, "moved");
    else if (c.latest !== e.folderHash) out.state.set(e.name, "available");
  }
  return out;
}

// ─── GitHub ─────────────────────────────────────────────────────────────────

export type Fetch = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** `gh api <endpoint>`: its JSON; null when GitHub refused this one (not
 *  found); "unavailable" when gh isn't installed or isn't logged in. Synthra
 *  never sees the token; gh sends it. */
export type GhApi = (endpoint: string) => Promise<unknown>;

export interface GitHubOptions {
  fetch?: Fetch;
  /** GITHUB_TOKEN or GH_TOKEN by default: 5000 requests an hour, not 60. */
  token?: string | null;
  /** When the hourly limit is used up (or a repo is private), ask the
   *  GitHub CLI instead, as `npx skills` does. null = don't. */
  ghApi?: GhApi | null;
}

const ghCli: GhApi = (endpoint) =>
  new Promise((done) => {
    execFile(
      "gh",
      ["api", endpoint],
      { timeout: 30_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const missing =
            (err as NodeJS.ErrnoException).code === "ENOENT" ||
            /auth login|not logged in/i.test(String(stderr));
          return done(missing ? "unavailable" : null);
        }
        try {
          done(JSON.parse(stdout));
        } catch {
          done(null);
        }
      },
    );
  });

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
}
interface Tree {
  sha: string;
  truncated?: boolean;
  tree: TreeEntry[];
}

const TIMEOUT_MS = 10_000;

function client(o: GitHubOptions) {
  const doFetch: Fetch =
    o.fetch ??
    ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }) as never);
  const token =
    o.token === undefined ? (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null) : o.token;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "synthra",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const ghApi = o.ghApi === undefined ? ghCli : o.ghApi;
  /** Set once GitHub says the hourly limit is used up: later trees go
   *  straight to gh, or fail at once without asking GitHub again. */
  let limited: { until: number | null } | null = null;
  let ghWorks = true;
  const viaGh = async (endpoint: string): Promise<Tree | null> => {
    if (!ghApi || !ghWorks) return null;
    const t = await ghApi(endpoint);
    if (t === "unavailable") ghWorks = false;
    return t && typeof t === "object" && Array.isArray((t as Tree).tree) ? (t as Tree) : null;
  };
  const limitText = () => {
    const at = limited?.until
      ? ` until ${new Date(limited.until * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
      : "";
    return `GitHub's limit of 60 checks an hour is used up${at}. Log in with the GitHub CLI (gh auth login) or set GITHUB_TOKEN to check more often`;
  };
  /** A tree, or why not. */
  const tree = async (source: string, ref: string): Promise<Tree | string> => {
    const endpoint = `repos/${source}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
    if (limited) {
      const t = await viaGh(endpoint);
      if (t) return t;
      return ghApi && ghWorks ? "not found (private, renamed or deleted)" : limitText();
    }
    try {
      const r = await doFetch(`https://api.github.com/${endpoint}`, { headers });
      if (r.ok) {
        const t = (await r.json()) as Tree;
        return Array.isArray(t?.tree) ? t : "GitHub sent something unexpected";
      }
      if (
        (r.status === 403 || r.status === 429) &&
        r.headers.get("x-ratelimit-remaining") === "0"
      ) {
        const reset = Number(r.headers.get("x-ratelimit-reset"));
        limited = { until: Number.isFinite(reset) && reset > 0 ? reset : null };
        return tree(source, ref);
      }
      if (r.status === 404 || r.status === 401) {
        // Private to GitHub's public API, but maybe not to the user's gh.
        const t = await viaGh(endpoint);
        if (t) return t;
        return "not found (private, renamed or deleted)";
      }
      return `GitHub said ${r.status}`;
    } catch (e) {
      return `GitHub didn't answer (${(e as Error).message})`;
    }
  };
  const raw = async (source: string, ref: string, path: string): Promise<string | null> => {
    try {
      const r = await doFetch(`https://raw.githubusercontent.com/${source}/${ref}/${path}`, {
        headers: { "User-Agent": "synthra" },
      });
      return r.ok ? await r.text() : null;
    } catch {
      return null;
    }
  };
  return { tree, raw };
}

/** The repo's tree on its branch: the lock's ref, else the default branch. */
async function repoTree(
  gh: ReturnType<typeof client>,
  source: string,
  ref: string | undefined,
): Promise<{ tree: Tree; branch: string } | string> {
  let why = "";
  for (const branch of ref ? [ref] : ["HEAD", "main", "master"]) {
    const t = await gh.tree(source, branch);
    if (typeof t !== "string") return { tree: t, branch };
    why = t;
    if (t.includes("limit")) break;
  }
  return why;
}

export interface CheckResult {
  checked: number;
  available: number;
  moved: number;
  errors: string[];
}

/** Ask GitHub for each source's tree once, compare every skill's folder hash,
 *  and keep the answer in updates.json. */
export async function checkUpdates(
  paths: SynthraPaths,
  opts: GitHubOptions & { now?: Date } = {},
): Promise<CheckResult> {
  const state = paths.skillState;
  const lock = await readLockEntries(skillLockPath(paths, "global"));
  const gh = client(opts);
  const check: UpdateCheck = {
    checkedAt: (opts.now ?? new Date()).toISOString(),
    skills: {},
    errors: {},
  };
  const bySource = new Map<string, LockEntry[]>();
  for (const e of lock) {
    const k = `${e.source}\n${e.ref ?? ""}`;
    bySource.set(k, [...(bySource.get(k) ?? []), e]);
  }
  const result: CheckResult = { checked: 0, available: 0, moved: 0, errors: [] };
  // A repo that can't be checked now keeps what the last check found.
  const before = await readCheck(state);
  for (const list of bySource.values()) {
    const first = list[0];
    if (!first) continue;
    const got = await repoTree(gh, first.source, first.ref);
    if (typeof got === "string") {
      check.errors[first.source] = got;
      for (const e of list) {
        const old = before?.skills[e.name];
        if (old) check.skills[e.name] = old;
      }
      continue;
    }
    const folders = new Map(
      got.tree.tree.filter((x) => x.type === "tree").map((x) => [x.path, x.sha]),
    );
    for (const e of list) {
      const folder = folderOf(e.skillPath);
      const latest = folder ? folders.get(folder) : got.tree.sha;
      if (latest === undefined && got.tree.truncated) {
        check.errors[e.source] = "the repo is too big for GitHub to list";
        continue;
      }
      check.skills[e.name] = {
        installed: e.folderHash,
        latest: latest ?? null,
        branch: got.branch,
      };
      result.checked++;
      if (latest === undefined) result.moved++;
      else if (latest !== e.folderHash) result.available++;
    }
  }
  result.errors = groupErrors(check.errors);
  await mkdir(state, { recursive: true });
  await writeJsonAtomic(checkFile(state), check);
  return result;
}

// ─── what an update changes ─────────────────────────────────────────────────

/** Git's hash of a file. Installed files may have Windows line endings, so a
 *  file counts as unchanged when either form matches. */
function blobShas(buf: Buffer): string[] {
  const sha = (b: Buffer) =>
    createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");
  const out = [sha(buf)];
  const text = buf.toString("utf8");
  if (text.includes("\r\n") && Buffer.from(text, "utf8").equals(buf)) {
    out.push(sha(Buffer.from(text.replace(/\r\n/g, "\n"), "utf8")));
  }
  return out;
}

async function localFiles(dir: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const walk = async (rel: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(rel ? join(dir, ...rel.split("/")) : dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.size >= 500 || e.name === ".git" || e.name === "node_modules") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < 8) await walk(r, depth + 1);
      } else if (e.isFile()) {
        const buf = await readFile(join(dir, ...r.split("/"))).catch(() => null);
        if (buf) out.set(r, blobShas(buf));
      }
    }
  };
  await walk("", 0);
  return out;
}

/** The files of a tree under a folder, relative to it. */
function filesUnder(tree: Tree, folder: string): Map<string, string> {
  const prefix = folder ? `${folder}/` : "";
  return new Map(
    tree.tree
      .filter((x) => x.type === "blob" && x.path.startsWith(prefix))
      .map((x) => [x.path.slice(prefix.length), x.sha]),
  );
}

export interface UpdateDiff {
  name: string;
  source: string;
  /** SKILL.md here, and on GitHub now. */
  before: string;
  after: string;
  /** Files the update adds, changes and removes (relative to the skill). */
  added: string[];
  changed: string[];
  removed: string[];
  /** Files changed here since the install: the update replaces them. Null =
   *  couldn't tell (GitHub had no copy of the installed version). */
  editedHere: string[] | null;
}

/** What updating one skill would change. Two trees from GitHub (the installed
 *  folder and the repo now) and one raw SKILL.md. */
export async function updateDiff(
  paths: SynthraPaths,
  name: string,
  opts: GitHubOptions = {},
): Promise<UpdateDiff | string> {
  const lock = await readLockEntries(skillLockPath(paths, "global"));
  const e = lock.find((x) => x.name === name);
  if (!e) return `"${name}" isn't a skill installed from GitHub.`;
  const gh = client(opts);
  const got = await repoTree(gh, e.source, e.ref);
  if (typeof got === "string") return `${e.source}: ${got}`;
  const folder = folderOf(e.skillPath);
  const latest = folder
    ? got.tree.tree.find((x) => x.type === "tree" && x.path === folder)?.sha
    : got.tree.sha;
  if (!latest) {
    return `"${name}" isn't at ${e.skillPath} in ${e.source} any more. Updating finds where it moved, or says it was removed.`;
  }
  const now = filesUnder(got.tree, folder);
  const was = await gh.tree(e.source, e.folderHash);
  const before = typeof was === "string" ? null : filesUnder(was, "");

  // Claude's copy, else the installer's own (a skill installed only for
  // other agents lives in ~/.agents/skills alone).
  const skill = await findSkill(paths, name, "global");
  const agentsDir = join(dirname(dirname(paths.globalSkillsDir)), ".agents", "skills", name);
  const skillFile = skill
    ? skill.path
    : await readFile(join(agentsDir, "SKILL.md")).then(
        () => join(agentsDir, "SKILL.md"),
        () => null,
      );
  const here = skillFile ? await localFiles(dirname(skillFile)) : new Map<string, string[]>();
  const base = before ?? new Map([...here].map(([p, s]) => [p, s[s.length - 1] ?? ""]));
  const added = [...now.keys()].filter((p) => !base.has(p)).sort();
  const removed = [...base.keys()].filter((p) => !now.has(p)).sort();
  const changed = [...now.keys()].filter((p) => base.has(p) && base.get(p) !== now.get(p)).sort();
  const editedHere =
    before && skillFile
      ? [
          ...[...here].filter(([p, s]) => !s.includes(before.get(p) ?? "")).map(([p]) => p),
          ...[...before.keys()].filter((p) => !here.has(p)),
        ].sort()
      : null;

  const after = await gh.raw(e.source, got.branch, e.skillPath);
  if (after === null) return `Couldn't download the new SKILL.md of "${name}" from GitHub.`;
  const local = skillFile ? await readFile(skillFile, "utf8").catch(() => "") : "";
  return { name, source: e.source, before: local, after, added, changed, removed, editedHere };
}

/** The command that updates these skills, or null for a name it can't take. */
export function updateCommand(names: string[]): string | null {
  if (!names.length || !names.every((n) => SKILL_NAME_RE.test(n))) return null;
  return `npx -y skills update ${names.join(" ")} -g -y`;
}
