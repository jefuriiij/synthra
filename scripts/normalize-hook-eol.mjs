// Prebuild guard: force LF on the POSIX hook sources before esbuild inlines them.
//
// esbuild's text loader reads from disk, not from git. `.gitattributes` sets
// `* text=auto eol=lf`, which means git normalizes CRLF->LF when hashing the
// working tree — so a CRLF file on disk hashes identical to its LF blob and
// `git status` reports the tree clean. One editor writing CRLF once (VS Code
// `files.eol`, Notepad, a PowerShell rewrite) then poisons every build from that
// machine with zero signal in git, and `git add --renormalize` is a no-op
// because the index was never wrong. That shipped a CRLF pre-tool-use.sh in
// 0.27.0. See issue #2.
//
// This runs as npm's `prebuild`, so it fires on the publisher's machine, which
// is the only place the contamination exists. It rewrites rather than fails —
// but it logs every file it touches, so a poisoned tree is visible instead of
// silently laundered.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src/hooks/scripts");

const files = (await readdir(SCRIPTS_DIR)).filter((f) => f.endsWith(".sh") || f.endsWith(".ps1"));
const fixed = [];

for (const name of files) {
  const path = join(SCRIPTS_DIR, name);
  const raw = await readFile(path, "utf8");
  if (!raw.includes("\r")) continue;
  // Sources stay LF for both extensions; installHooks converts .ps1 to CRLF at
  // write time, so CRLF here would double up to \r\r\n.
  await writeFile(path, raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "utf8");
  fixed.push(name);
}

if (fixed.length > 0) {
  console.warn(
    `\n  normalize-hook-eol: rewrote CR out of ${fixed.length} hook source(s): ${fixed.join(", ")}` +
      "\n  Your working tree had CRLF hook scripts. text=auto hashes them" +
      " identical to their LF blobs, so this never shows as a content diff and" +
      " can't be committed or caught in CI — but esbuild reads disk and would" +
      " have inlined the CR, breaking every Grep/Glob/Bash call in a Claude Code" +
      " session. Check your editor's line-ending setting so it stops happening.\n",
  );
} else {
  console.log(`normalize-hook-eol: ${files.length} hook source(s) already LF`);
}
