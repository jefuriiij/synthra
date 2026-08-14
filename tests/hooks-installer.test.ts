// installHooks writes into .claude/settings.local.json — a file the user owns,
// that Claude Code also writes, and that holds every permission they've granted.
// These tests exist because it used to rebuild that file from an empty object
// whenever it couldn't parse it.

import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { installHooks, normalizeEol } from "../src/hooks/installer.js";
import { resolvePaths } from "../src/shared/paths.js";

const SCRIPTS_DIR = fileURLToPath(new URL("../src/hooks/scripts", import.meta.url));

async function project(): Promise<ReturnType<typeof resolvePaths>> {
  const root = await mkdtemp(join(tmpdir(), "syn-installer-"));
  return resolvePaths(root);
}

/** A settings file shaped like a real one: permissions plus a foreign hook. */
const REAL_SETTINGS = {
  permissions: {
    allow: ["Bash(npm run test:*)", "Bash(git status)", "Read(//c/Users/Jeff/**)"],
    deny: ["Bash(rm -rf *)"],
  },
  hooks: {
    Stop: [{ hooks: [{ type: "command", command: "echo 'someone elses hook'" }] }],
  },
};

describe("installHooks", () => {
  it("creates the file on a first run", async () => {
    const paths = await project();
    const r = await installHooks(paths);
    expect(r.settingsUpdated).toBe(true);
    expect(r.scriptsWritten.length).toBeGreaterThan(0);
    const cfg = JSON.parse(await readFile(paths.claudeSettings, "utf8"));
    expect(Object.keys(cfg.hooks).length).toBeGreaterThan(0);
  });

  it("keeps the user's permissions and foreign hooks when merging", async () => {
    const paths = await project();
    await mkdir(join(paths.claudeDir), { recursive: true });
    await writeFile(paths.claudeSettings, JSON.stringify(REAL_SETTINGS, null, 2), "utf8");

    await installHooks(paths);
    const cfg = JSON.parse(await readFile(paths.claudeSettings, "utf8"));

    expect(cfg.permissions).toEqual(REAL_SETTINGS.permissions);
    const stopCommands = cfg.hooks.Stop.flatMap((e: { hooks: { command: string }[] }) =>
      e.hooks.map((h) => h.command),
    );
    expect(stopCommands.some((c: string) => c.includes("someone elses hook"))).toBe(true);
    expect(stopCommands.some((c: string) => c.includes("synthra-stop"))).toBe(true);
  });

  it("is idempotent — re-running doesn't duplicate our hook entries", async () => {
    const paths = await project();
    await installHooks(paths);
    await installHooks(paths);
    const cfg = JSON.parse(await readFile(paths.claudeSettings, "utf8"));
    const ours = cfg.hooks.Stop.flatMap((e: { hooks: { meta?: string }[] }) =>
      e.hooks.filter((h) => h.meta === "synthra-hook=true"),
    );
    expect(ours).toHaveLength(1);
  });

  // v0.26: Claude Code owns this file too and rewrites it on every permission
  // approval. Reading it, merging, and writing back as separate steps meant an
  // approval granted in that gap was silently discarded.
  it("keeps a permission written concurrently with the install", async () => {
    const paths = await project();
    await mkdir(paths.claudeDir, { recursive: true });
    await writeFile(paths.claudeSettings, JSON.stringify(REAL_SETTINGS, null, 2), "utf8");

    // Land a new permission while installHooks is mid-flight.
    const racer = (async () => {
      const current = JSON.parse(await readFile(paths.claudeSettings, "utf8"));
      current.permissions = current.permissions ?? {};
      current.permissions.allow = [
        ...(current.permissions.allow ?? []),
        "Bash(granted-mid-install)",
      ];
      await writeFile(paths.claudeSettings, JSON.stringify(current, null, 2), "utf8");
    })();

    const [r] = await Promise.all([installHooks(paths), racer]);
    expect(r.settingsUpdated).toBe(true);

    const cfg = JSON.parse(await readFile(paths.claudeSettings, "utf8"));
    expect(cfg.permissions?.allow).toContain("Bash(granted-mid-install)");
    // ...and our hooks still registered.
    expect(JSON.stringify(cfg.hooks)).toContain("synthra-hook=true");
  });

  // THE regression. Before this, an unparseable settings file was read as {},
  // merged, and written back containing only Synthra's hooks — annihilating the
  // user's permissions and any hook another tool had installed.
  it("refuses to touch an unreadable settings file", async () => {
    const paths = await project();
    await mkdir(join(paths.claudeDir), { recursive: true });
    const damaged = `${JSON.stringify(REAL_SETTINGS, null, 2)}\n{{{ truncated garbage`;
    await writeFile(paths.claudeSettings, damaged, "utf8");

    const r = await installHooks(paths);

    expect(r.settingsUpdated).toBe(false);
    expect(r.settingsUnreadable).toBeTruthy();
    // A copy was set aside so the user can recover their permissions...
    const copies = (await readdir(paths.claudeDir)).filter((n) => n.includes(".corrupt-"));
    expect(copies).toHaveLength(1);
    expect(await readFile(join(paths.claudeDir, copies[0] as string), "utf8")).toBe(damaged);
    // ...and no rebuilt-from-nothing file was written in its place.
    const rebuilt = (await readdir(paths.claudeDir)).includes("settings.local.json");
    expect(rebuilt).toBe(false);
    // The hook scripts themselves still landed — only registration was skipped.
    expect(r.scriptsWritten.length).toBeGreaterThan(0);
  });

  it("still writes the hook scripts even when settings can't be registered", async () => {
    const paths = await project();
    await mkdir(join(paths.claudeDir), { recursive: true });
    await writeFile(paths.claudeSettings, "not json", "utf8");
    const r = await installHooks(paths);
    for (const script of r.scriptsWritten) {
      expect((await readFile(script, "utf8")).length).toBeGreaterThan(0);
    }
  });

  it("leaves no temp files behind", async () => {
    const paths = await project();
    await installHooks(paths);
    expect((await readdir(paths.claudeDir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  // v0.27.0 shipped pre-tool-use.sh with CRLF. bash dies at parse time
  // (`$'\r': command not found`), and because that hook's matcher is
  // Grep|Glob|Bash, the session loses all three tools — so the agent can't even
  // repair it. The source was clean in git the whole time: `text=auto` hashes a
  // CRLF working-tree file identical to its LF blob, so only the build machine's
  // disk was poisoned and esbuild inlined the CR verbatim. Issue #2.
  it.skipIf(process.platform === "win32")(
    "writes bash hooks with LF endings and no CR anywhere",
    async () => {
      const paths = await project();
      const r = await installHooks(paths);

      expect(r.scriptsWritten.length).toBeGreaterThan(0);
      for (const script of r.scriptsWritten) {
        expect(script.endsWith(".sh")).toBe(true);
        const body = await readFile(script, "utf8");
        expect(body).not.toContain("\r");
        expect(body.startsWith("#!/usr/bin/env bash\n")).toBe(true);
      }
    },
  );

  // The write-site normalization is what makes the fix hold regardless of build
  // state, so assert it on a deliberately poisoned body — the inlined bodies are
  // static imports and can't be contaminated from inside a test.
  it("strips CR from a contaminated body and leaves a clean one untouched", () => {
    expect(normalizeEol("#!/usr/bin/env bash\r\nset +e\r\n", ".sh")).toBe(
      "#!/usr/bin/env bash\nset +e\n",
    );
    expect(normalizeEol("a\nb\n", ".sh")).toBe("a\nb\n");
    // PowerShell wants CRLF, and normalizing must be idempotent — a body that
    // is already CRLF must not double up to \r\r\n.
    expect(normalizeEol("a\nb\n", ".ps1")).toBe("a\r\nb\r\n");
    expect(normalizeEol("a\r\nb\r\n", ".ps1")).toBe("a\r\nb\r\n");
  });

  // Guards the build machine itself: this reads the sources off disk exactly
  // like esbuild's text loader does, so a CRLF working tree fails here even
  // though it produces no committable diff. CI always checks out LF, so this can
  // only ever fire locally — which is the point, since the publisher's disk is
  // the one place the contamination exists.
  it("ships no hook source with a CR on disk", async () => {
    const shFiles = (await readdir(SCRIPTS_DIR)).filter((f) => f.endsWith(".sh"));
    expect(shFiles.length).toBeGreaterThan(0);

    const contaminated: string[] = [];
    for (const name of shFiles) {
      const body = await readFile(join(SCRIPTS_DIR, name), "utf8");
      if (body.includes("\r")) contaminated.push(name);
    }
    expect(contaminated).toEqual([]);
  });

  // Upgrading from a version that wrote both extensions, or sharing a checkout
  // across platforms, left orphan hooks that no later run touched.
  it.skipIf(process.platform === "win32")("prunes the stale .ps1 counterparts", async () => {
    const paths = await project();
    await mkdir(paths.claudeHooksDir, { recursive: true });
    const orphan = join(paths.claudeHooksDir, "synthra-pre-tool-use.ps1");
    await writeFile(orphan, "# left over from an older install", "utf8");

    await installHooks(paths);

    const remaining = await readdir(paths.claudeHooksDir);
    expect(remaining.filter((n) => n.endsWith(".ps1"))).toEqual([]);
    expect(remaining).toContain("synthra-pre-tool-use.sh");
  });
});
