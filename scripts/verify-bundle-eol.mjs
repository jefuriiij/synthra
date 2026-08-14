// Postbuild assertion: no inlined POSIX hook body in the shipped bundle carries
// a CR. This has to run against dist, not src — the 0.27.0 regression passed
// every source-level check, because the source WAS clean in git; only the build
// machine's working tree was poisoned. See issue #2 and normalize-hook-eol.mjs.
//
// Note the obvious check does not work: `grep -q '\r' dist/cli/index.js` matches
// ~26 legitimate /\r?\n/ regexes in ordinary JS (frontmatter parsing, git
// porcelain splitting, and installer.ts's own normalizeEol). So anchor on the
// bash shebang instead and extract each hook's template literal exactly.

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHEBANG = "`#!/usr/bin/env bash";

/** Walk a template literal from its opening backtick to the matching close,
 *  honouring esbuild's backslash escapes (\` and \${ appear in hook bodies). */
function readTemplate(src, openIdx) {
  let out = "";
  for (let i = openIdx + 1; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      out += c + src[i + 1];
      i++;
      continue;
    }
    if (c === "`") return out;
    out += c;
  }
  return null; // unterminated — treated as a failure below
}

function bashBodies(src) {
  const found = [];
  for (let i = src.indexOf(SHEBANG); i !== -1; i = src.indexOf(SHEBANG, i + 1)) {
    found.push(readTemplate(src, i));
  }
  return found;
}

const expected = (await readdir(join(ROOT, "src/hooks/scripts"))).filter((f) =>
  f.endsWith(".sh"),
).length;

const distFiles = [];
for (const sub of ["cli", "server", "dashboard"]) {
  const dir = join(ROOT, "dist", sub);
  const entries = await readdir(dir).catch(() => []);
  for (const e of entries) if (e.endsWith(".js")) distFiles.push(join(dir, e));
}

const problems = [];
let cliCount = 0;

for (const file of distFiles) {
  const src = await readFile(file, "utf8");
  const bodies = bashBodies(src);
  if (file.endsWith(join("cli", "index.js"))) cliCount = bodies.length;

  for (const [n, body] of bodies.entries()) {
    const where = `${relative(ROOT, file)} (bash body #${n + 1})`;
    if (body === null) {
      problems.push(`${where}: unterminated template literal — extraction is out of date`);
      continue;
    }
    // Two distinct failure modes: esbuild emits a CR from disk as the literal
    // two-character escape \r inside the template, and a raw CR byte would also
    // survive verbatim. A template literal turns either into CR on write.
    if (body.includes("\\r")) problems.push(`${where}: contains a literal \\r escape`);
    if (body.includes("\r")) problems.push(`${where}: contains a raw CR byte`);
  }
}

// Guard the guard: if the anchor stops matching, this script must fail loudly
// rather than pass by finding nothing to check.
if (cliCount !== expected) {
  problems.push(
    `dist/cli/index.js has ${cliCount} inlined bash hook bodies, expected ${expected}` +
      " (one per src/hooks/scripts/*.sh) — the bundle format changed and this check is blind",
  );
}

if (problems.length > 0) {
  console.error("\nverify-bundle-eol: FAILED\n");
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    "\n  A CRLF bash hook breaks Grep/Glob/Bash for the whole session (issue #2)." +
      "\n  Run `npm run build` again — prebuild normalization should fix the source.\n",
  );
  process.exit(1);
}

console.log(`verify-bundle-eol: ${cliCount} inlined bash hook body(s), all LF`);
