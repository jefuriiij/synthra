// HTML parser. Gives plain markup real symbols — which it never had.
//
// WHY (don't simplify this away): `.html` used to route straight to the HubL
// parser, so a file with no `{% macro %}` produced ZERO symbols. Two consequences
// showed up in six separate dogfood sessions:
//   - the Moat blocked searches for CSS class names in a KNOWN file and then
//     redirected to whatever minified vendor JS happened to rank for the token,
//     because markup had nothing to match with;
//   - `graph_read` could not slice a markup file at all, so every edit round on a
//     3,400-line page was a whole-file relationship (191 file references in one day).
//
// A self-contained page carries its structure in three places, so we read all
// three: sections and id'd elements (the landmarks you navigate by), the CSS rules
// in <style> (what you actually search for), and any inline <script>.
//
// HubL still runs first — a .html file may be a HubSpot template, plain markup, or
// both, and the two extractions are additive.

import { createParser, type ParsedFile, type ParsedSymbol } from "../parser.js";
import type { WalkedFile } from "../walker.js";
import { parseHubL } from "./hubl.js";
import { parseTypeScript } from "./typescript.js";

/** Elements that mark a region of a page, and so make useful slice targets. */
const LANDMARK_TAGS = new Set([
  "section",
  "main",
  "header",
  "footer",
  "nav",
  "article",
  "aside",
  "dialog",
  "template",
]);

// A single page can legitimately define hundreds of rules; a minified or
// generated stylesheet can define thousands. Cap so one file can't swamp the
// graph — the cap is per file and generous enough that real pages never hit it.
const MAX_CSS_SYMBOLS = 400;
const MAX_LANDMARK_SYMBOLS = 200;

interface Walked {
  type: string;
  text: string;
  startRow: number;
  endRow: number;
  children: Walked[];
}

/** Depth-first collect of every node — the trees here are small enough that a
 *  full walk is simpler (and faster to reason about) than a query per shape. */
function walk(node: unknown): Walked {
  const n = node as {
    type: string;
    text: string;
    startPosition: { row: number };
    endPosition: { row: number };
    namedChildCount: number;
    namedChild: (i: number) => unknown;
  };
  const children: Walked[] = [];
  for (let i = 0; i < n.namedChildCount; i++) {
    const child = n.namedChild(i);
    if (child) children.push(walk(child));
  }
  return {
    type: n.type,
    text: n.text,
    startRow: n.startPosition.row,
    endRow: n.endPosition.row,
    children,
  };
}

function eachNode(root: Walked, fn: (n: Walked) => void): void {
  fn(root);
  for (const c of root.children) eachNode(c, fn);
}

/**
 * Strip a BEM-style modifier so `.bcard`, `.bcard--feat` and `.bcard--nar` are
 * one symbol rather than three. The base rule is what anyone searches for, and
 * keeping every variant separate buried real matches under near-duplicates.
 */
function baseClassName(cls: string): string {
  const cut = cls.indexOf("--");
  return cut > 0 ? cls.slice(0, cut) : cls;
}

/** Attribute value on an element's start tag, e.g. id or class. */
function attrValue(element: Walked, want: string): string | null {
  const start = element.children.find(
    (c) => c.type === "start_tag" || c.type === "self_closing_tag",
  );
  if (!start) return null;
  for (const attr of start.children) {
    if (attr.type !== "attribute") continue;
    const nameNode = attr.children.find((c) => c.type === "attribute_name");
    if (nameNode?.text.toLowerCase() !== want) continue;
    const quoted = attr.children.find((c) => c.type === "quoted_attribute_value");
    const value = quoted?.children.find((c) => c.type === "attribute_value");
    return (value ?? quoted)?.text ?? null;
  }
  return null;
}

function tagNameOf(element: Walked): string | null {
  const start = element.children.find(
    (c) => c.type === "start_tag" || c.type === "self_closing_tag",
  );
  return start?.children.find((c) => c.type === "tag_name")?.text.toLowerCase() ?? null;
}

/** Raw text of a <style>/<script> element, plus the line its content starts on. */
function rawTextOf(element: Walked): { text: string; startRow: number } | null {
  const raw = element.children.find((c) => c.type === "raw_text");
  return raw ? { text: raw.text, startRow: raw.startRow } : null;
}

/** CSS class symbols from one stylesheet, offset onto the host file's lines. */
async function cssSymbols(css: string, lineOffset: number): Promise<ParsedSymbol[]> {
  const { parser } = await createParser("css");
  const tree = parser.parse(css);
  if (!tree?.rootNode) return [];

  // First definition wins the line range: base rules come before their @media
  // overrides, and merging the ranges would make a slice span half the file.
  const byName = new Map<string, { sym: ParsedSymbol; rules: number }>();

  eachNode(walk(tree.rootNode), (node) => {
    if (node.type !== "rule_set") return;
    const selectors = node.children.find((c) => c.type === "selectors");
    if (!selectors) return;

    const seenHere = new Set<string>();
    eachNode(selectors, (sel) => {
      if (sel.type !== "class_name") return;
      const name = baseClassName(sel.text);
      if (!name || seenHere.has(name)) return;
      seenHere.add(name);

      const existing = byName.get(name);
      if (existing) {
        existing.rules += 1;
        return;
      }
      if (byName.size >= MAX_CSS_SYMBOLS) return;
      byName.set(name, {
        rules: 1,
        sym: {
          name,
          kind: "component",
          startLine: node.startRow + 1 + lineOffset,
          endLine: node.endRow + 1 + lineOffset,
          signature: `.${name} { … }`,
        },
      });
    });
  });

  return [...byName.values()].map(({ sym, rules }) => ({
    ...sym,
    // Say when a class is styled in more than one place, so a slice that looks
    // short is understood to be the base rule rather than the whole story.
    signature: rules > 1 ? `.${sym.name} { … }  (${rules} rules)` : sym.signature,
  }));
}

export async function parseHtml(f: WalkedFile, source: string): Promise<ParsedFile> {
  // HubL first: a .html file may be a HubSpot template, and macro/block symbols
  // plus include/extends edges must keep working exactly as before.
  const out = parseHubL(f, source);

  let root: Walked;
  try {
    const { parser } = await createParser("html");
    const tree = parser.parse(source);
    if (!tree?.rootNode) return out;
    root = walk(tree.rootNode);
  } catch {
    return out; // malformed or unloadable — HubL symbols still stand
  }

  const styles: { text: string; startRow: number }[] = [];
  const scripts: { text: string; startRow: number }[] = [];
  const landmarks: ParsedSymbol[] = [];
  const seenLandmark = new Set<string>();

  eachNode(root, (node) => {
    if (node.type === "style_element") {
      const raw = rawTextOf(node);
      if (raw) styles.push(raw);
      return;
    }
    if (node.type === "script_element") {
      const raw = rawTextOf(node);
      // A <script src=…> has no body; JSON-LD and templates aren't JavaScript.
      if (raw?.text.trim()) scripts.push(raw);
      return;
    }
    if (node.type !== "element") return;

    const tag = tagNameOf(node);
    if (!tag) return;
    const id = attrValue(node, "id");
    // Landmarks are worth indexing on their own; anything else needs an id to
    // be worth a name, or we'd emit a symbol for every <div> on the page.
    if (!LANDMARK_TAGS.has(tag) && !id) return;

    const firstClass = (attrValue(node, "class") ?? "").trim().split(/\s+/)[0] ?? "";
    const name = id || firstClass || tag;
    if (!name || seenLandmark.has(name) || landmarks.length >= MAX_LANDMARK_SYMBOLS) return;
    seenLandmark.add(name);

    const attrs = [id ? `id="${id}"` : "", firstClass ? `class="${firstClass}"` : ""]
      .filter(Boolean)
      .join(" ");
    landmarks.push({
      name,
      kind: "component",
      startLine: node.startRow + 1,
      endLine: node.endRow + 1,
      signature: `<${tag}${attrs ? ` ${attrs}` : ""}>`,
    });
  });

  out.symbols.push(...landmarks);

  for (const style of styles) {
    try {
      out.symbols.push(...(await cssSymbols(style.text, style.startRow)));
    } catch {
      // A stylesheet that won't parse shouldn't cost us the rest of the file.
    }
  }

  // Inline <script> gets the same treatment Svelte's does — real JS symbols,
  // shifted onto the host file's line numbers.
  for (const script of scripts) {
    try {
      const virtual: WalkedFile = { ...f, ext: ".js" };
      const parsed = await parseTypeScript(virtual, script.text);
      for (const sym of parsed.symbols) {
        out.symbols.push({
          ...sym,
          startLine: sym.startLine + script.startRow,
          endLine: sym.endLine + script.startRow,
        });
      }
      for (const call of parsed.calls) {
        out.calls.push({ ...call, line: call.line + script.startRow });
      }
    } catch {
      // Inline script that won't parse — markup symbols still stand.
    }
  }

  return out;
}
