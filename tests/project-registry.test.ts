// ~/.synthra/projects.json — the machine-wide list the dashboard enumerates.
// Until the path became an injectable argument, four of this module's five
// exports were untestable and had zero coverage. This is that coverage.

import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  forgetProject,
  listProjects,
  recordProject,
  registryPath,
} from "../src/shared/project-registry.js";

async function regFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "syn-reg-")), "projects.json");
}

describe("registryPath", () => {
  it("resolves under the given home rather than the real one", () => {
    expect(registryPath("/fake/home").replace(/\\/g, "/")).toBe(
      "/fake/home/.synthra/projects.json",
    );
  });
});

describe("recordProject", () => {
  it("creates the registry on a first run", async () => {
    const p = await regFile();
    await recordProject("C:\\proj\\alpha", p);
    const reg = JSON.parse(await readFile(p, "utf8"));
    expect(reg.schema_version).toBe(1);
    expect(reg.projects).toHaveLength(1);
    expect(reg.projects[0].name).toBe("alpha");
    expect(reg.projects[0].first_seen).toBe(reg.projects[0].last_seen);
  });

  it("updates last_seen but preserves first_seen on a repeat run", async () => {
    const p = await regFile();
    await recordProject("C:\\proj\\alpha", p);
    const first = JSON.parse(await readFile(p, "utf8")).projects[0];
    await new Promise((r) => setTimeout(r, 5));
    await recordProject("C:\\proj\\alpha", p);
    const again = JSON.parse(await readFile(p, "utf8"));
    expect(again.projects).toHaveLength(1);
    expect(again.projects[0].first_seen).toBe(first.first_seen);
    expect(again.projects[0].last_seen >= first.last_seen).toBe(true);
  });

  it("keeps entries for other projects", async () => {
    const p = await regFile();
    await recordProject("C:\\proj\\alpha", p);
    await recordProject("C:\\proj\\beta", p);
    const names = JSON.parse(await readFile(p, "utf8")).projects.map(
      (e: { name: string }) => e.name,
    );
    expect(names.sort()).toEqual(["alpha", "beta"]);
  });

  // The most likely lost update in real use: two `syn .` runs in different
  // projects within the same second each read, each add only itself, one wins.
  it("does not lose an entry when two projects register at once", async () => {
    const p = await regFile();
    await Promise.all([
      recordProject("C:\\proj\\alpha", p),
      recordProject("C:\\proj\\beta", p),
      recordProject("C:\\proj\\gamma", p),
    ]);
    const names = JSON.parse(await readFile(p, "utf8")).projects.map(
      (e: { name: string }) => e.name,
    );
    expect(names.sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("quarantines an unparseable registry instead of replacing it", async () => {
    const p = await regFile();
    const realish = JSON.stringify({
      schema_version: 1,
      projects: [
        { path: "C:\\a", name: "a", first_seen: "x", last_seen: "x" },
        { path: "C:\\b", name: "b", first_seen: "x", last_seen: "x" },
      ],
    });
    await writeFile(p, realish.slice(0, -20), "utf8"); // truncated

    await recordProject("C:\\proj\\new", p);

    // no 1-entry replacement, and the original is recoverable
    const dir = join(p, "..");
    const copies = (await readdir(dir)).filter((n) => n.includes(".corrupt-"));
    expect(copies).toHaveLength(1);
    expect(await readFile(join(dir, copies[0] as string), "utf8")).toContain('"name":"b"');
    expect((await readdir(dir)).includes("projects.json")).toBe(false);
  });
});

describe("listProjects", () => {
  it("returns [] when there's no registry yet", async () => {
    expect(await listProjects(await regFile())).toEqual([]);
  });

  it("sorts by last_seen, most recent first", async () => {
    const p = await regFile();
    await writeFile(
      p,
      JSON.stringify({
        schema_version: 1,
        projects: [
          { path: "C:\\old", name: "old", first_seen: "a", last_seen: "2026-01-01T00:00:00Z" },
          { path: "C:\\new", name: "new", first_seen: "a", last_seen: "2026-07-01T00:00:00Z" },
        ],
      }),
      "utf8",
    );
    expect((await listProjects(p)).map((e) => e.name)).toEqual(["new", "old"]);
  });

  it("returns [] for an unparseable registry without destroying it", async () => {
    const p = await regFile();
    await writeFile(p, "{ broken", "utf8");
    expect(await listProjects(p)).toEqual([]);
    // reading must not quarantine or rewrite — that's recordProject's job
    expect(await readFile(p, "utf8")).toBe("{ broken");
  });
});

describe("forgetProject", () => {
  it("removes an exact-path match and reports it", async () => {
    const p = await regFile();
    await recordProject("C:\\proj\\alpha", p);
    await recordProject("C:\\proj\\beta", p);
    expect(await forgetProject("C:\\proj\\alpha", p)).toBe(true);
    expect((await listProjects(p)).map((e) => e.name)).toEqual(["beta"]);
  });

  it("reports false when there's nothing to remove, and writes nothing", async () => {
    const p = await regFile();
    await recordProject("C:\\proj\\alpha", p);
    const before = await readFile(p, "utf8");
    expect(await forgetProject("C:\\proj\\nope", p)).toBe(false);
    expect(await readFile(p, "utf8")).toBe(before);
  });

  it("reports false for a missing registry", async () => {
    expect(await forgetProject("C:\\proj\\alpha", await regFile())).toBe(false);
  });
});
