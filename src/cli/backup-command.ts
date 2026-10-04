// `syn backup [file]` and `syn restore <file>`: what Synthra keeps on this
// machine only (skills for every project, USER.md, favorites, history), in
// one JSON file for a new device. Restore merges and never overwrites; see
// src/learn/backup.ts.

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  type Backup,
  backupFileName,
  checkBackup,
  createBackup,
  restoreBackup,
  restoreSummary,
} from "../learn/backup.js";
import { resolvePaths } from "../shared/paths.js";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export async function backupCommand(file: string | undefined, { version }: { version: string }) {
  const out = resolve(file ?? backupFileName());
  const b = await createBackup(resolvePaths(process.cwd()), { version });
  await writeFile(out, `${JSON.stringify(b, null, 2)}\n`, "utf8");
  console.log(`Saved ${out}`);
  console.log(
    `  ${plural(b.skills.length, "skill")}, ${b.userMemory ? "USER.md, " : ""}${plural(b.favorites.length, "favorite")}, ${plural(b.ledger.length, "history event")}, ${plural(b.installed.length, "installed skill")} (as a list)`,
  );
  console.log("  It holds your notes about yourself: keep it private.");
}

export async function restoreCommand(file: string) {
  let b: unknown;
  try {
    b = JSON.parse(await readFile(resolve(file), "utf8"));
  } catch (err) {
    console.error(`Couldn't read ${file}: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  const bad = checkBackup(b);
  if (bad) {
    console.error(bad);
    process.exitCode = 1;
    return;
  }
  const report = await restoreBackup(resolvePaths(process.cwd()), b as Backup);
  for (const l of restoreSummary(report)) console.log(l);
}
