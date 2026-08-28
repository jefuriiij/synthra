// v0.28 — plain HTML gets real symbols.
//
// Before this, `.html` was missing from scan-command's PARSABLE_EXTS, so markup
// files never reached ANY parser and scanned to zero symbols. That is why the
// Moat kept blocking CSS-class searches in a known page and redirecting to
// whatever vendored JS ranked for the token: markup had nothing to match with,
// and graph_read could not slice a 3,400-line page.

import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseSource } from "../src/scanner/parser.js";
import { scanProject } from "../src/cli/scan-command.js";
import { readGraph } from "../src/graph/store.js";
import { retrieve } from "../src/graph/retrieve.js";
import { resolvePaths } from "../src/shared/paths.js";
import type { WalkedFile } from "../src/scanner/walker.js";

const wf = (relPath: string): WalkedFile => ({
  absPath: `/tmp/${relPath}`,
  relPath,
  ext: relPath.slice(relPath.lastIndexOf(".")),
  size: 0,
});

const PAGE = [
  "<html><head><style>",
  "  .bento{background:var(--cloud)}",
  "  .bcard{padding:8px}",
  "  .bcard--feat{padding:12px}",
  "  .bcard--nar{padding:4px}",
  "  @media(max-width:700px){ .bcard{padding:2px} }",
  "</style></head>",
  "<body>",
  '  <section id="hero" class="band">',
  "    <h1>Hi</h1>",
  "  </section>",
  '  <div id="tray">t</div>',
  "  <div class='nameless'>no id, not a landmark</div>",
  "  <script>function boot(){ return 1 }</script>",
  "</body></html>",
].join("\n");

const names = (syms: { name: string }[]) => syms.map((s) => s.name);

describe("parseHtml", () => {
  it("gives a plain page CSS, landmark and script symbols", async () => {
    const parsed = await parseSource(wf("page.html"), PAGE);
    const found = names(parsed.symbols);
    expect(found).toContain("bento"); // CSS rule
    expect(found).toContain("hero"); // <section id>
    expect(found).toContain("tray"); // id'd element
    expect(found).toContain("boot"); // inline <script>
  });

  it("groups BEM variants into one symbol", async () => {
    // .bcard, .bcard--feat and .bcard--nar are one thing you search for.
    const parsed = await parseSource(wf("page.html"), PAGE);
    const bcards = names(parsed.symbols).filter((n) => n.startsWith("bcard"));
    expect(bcards).toEqual(["bcard"]);
  });

  it("keeps the base rule's line range, not one spanning the media query", async () => {
    // Merging ranges would make graph_read slice half the file.
    const parsed = await parseSource(wf("page.html"), PAGE);
    const bcard = parsed.symbols.find((s) => s.name === "bcard" && s.signature.startsWith("."));
    expect(bcard).toBeDefined();
    expect((bcard?.endLine ?? 0) - (bcard?.startLine ?? 0)).toBeLessThan(2);
    // base + two modifiers + the @media override all fold into one symbol
    expect(bcard?.signature).toContain(" rules)");
  });

  it("does not emit a symbol for every anonymous div", async () => {
    const parsed = await parseSource(wf("page.html"), PAGE);
    expect(names(parsed.symbols)).not.toContain("nameless");
  });

  it("reports line numbers that point at the real source line", async () => {
    const parsed = await parseSource(wf("page.html"), PAGE);
    const bento = parsed.symbols.find((s) => s.name === "bento");
    // ".bento{...}" is line 2 of PAGE (1-based).
    expect(bento?.startLine).toBe(2);
  });

  it("still extracts HubL macros from a HubSpot template", async () => {
    // The .html path runs HubL first; both extractions are additive.
    const src = [
      "{% macro button(label) %}",
      "  <a>{{ label }}</a>",
      "{% endmacro %}",
      '<section id="s">x</section>',
    ].join("\n");
    const parsed = await parseSource(wf("mod.html"), src);
    const found = names(parsed.symbols);
    expect(found).toContain("button");
    expect(found).toContain("s");
  });

  it("still indexes an unclosed tag rather than giving up on the file", async () => {
    const parsed = await parseSource(
      wf("bad.html"),
      '<section id="a"><div>unclosed<style>.x{a:1}</style></section>',
    );
    expect(names(parsed.symbols)).toEqual(expect.arrayContaining(["a", "x"]));
  });
});

// THE regression that hid for months: hubl.test.ts called parseHubL directly, so
// nothing noticed that a real scan filtered .html out before parsing. This test
// goes through scanProject, the way the product actually runs.
describe("a real scan indexes markup", () => {
  it("produces symbols for an .html file end to end", async () => {
    const dir = await mkdtemp(join(tmpdir(), "syn-html-scan-"));
    await writeFile(join(dir, "page.html"), PAGE, "utf8");

    await scanProject(dir, { silent: true, skipBootstrap: true });

    const graph = await readGraph(resolvePaths(dir).infoGraph);
    expect(graph).not.toBeNull();
    expect(graph?.symbol_count ?? 0).toBeGreaterThan(0);
    const found = (graph?.nodes ?? [])
      .filter((n) => n.kind === "symbol")
      .map((n) => (n as { name: string }).name);
    expect(found).toContain("bento");
    expect(found).toContain("hero");
  });
});

// The dogfood complaint, as a test: a CSS-class search in a known page used to
// lose to whatever vendored JS happened to rank for the token, because markup
// had no symbols at all. Both halves of the v0.28 fix are needed here — the page
// needs symbols to match with, and the vendor file needs its accidental edge
// removed.
describe("a CSS-class search finds the page, not the vendor bundle", () => {
  it("ranks the markup file above third-party JS", async () => {
    const dir = await mkdtemp(join(tmpdir(), "syn-html-rank-"));
    await writeFile(join(dir, "page.html"), PAGE, "utf8");
    await mkdir(join(dir, "assets", "vendor"), { recursive: true });
    // Shaped like the real culprits: generic helpers whose names brush any token.
    await writeFile(
      join(dir, "assets", "vendor", "gsap.js"),
      [
        "export function bento(){ return 1 }",
        "export function bcardHelper(){ return 2 }",
        "export function top(){ return 3 }",
      ].join("\n"),
      "utf8",
    );

    await scanProject(dir, { silent: true, skipBootstrap: true });
    const graph = await readGraph(resolvePaths(dir).infoGraph);
    expect(graph).not.toBeNull();

    const result = await retrieve(graph as NonNullable<typeof graph>, "bento bcard");
    const paths = result.files.map((f) => f.path);
    expect(paths[0]).toBe("page.html");
    expect(paths.indexOf("page.html")).toBeLessThan(
      paths.indexOf("assets/vendor/gsap.js") === -1 ? 99 : paths.indexOf("assets/vendor/gsap.js"),
    );
  });
});
