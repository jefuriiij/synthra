// HubL (HubSpot CMS) parser tests.

import { describe, it, expect } from "vitest";

import { parseHubL } from "../src/scanner/parsers/hubl.js";
import { buildGraph } from "../src/scanner/extract.js";
import type { ParsedFile } from "../src/scanner/parser.js";
import type { WalkedFile } from "../src/scanner/walker.js";

function wf(relPath: string, source: string): WalkedFile {
  return { absPath: "/proj/" + relPath, relPath, ext: ".html", size: source.length };
}

describe("parseHubL", () => {
  it("extracts {% macro %} as a function symbol and {% block %} as a component", () => {
    const src = [
      "{% macro renderButton(label, url) %}",
      '  <a href="{{ url }}">{{ label }}</a>',
      "{% endmacro %}",
      "",
      "{% block content %}",
      "  <p>hi</p>",
      "{% endblock %}",
    ].join("\n");
    const parsed = parseHubL(wf("modules/btn.html", src), src);

    const macro = parsed.symbols.find((s) => s.name === "renderButton");
    expect(macro).toBeDefined();
    expect(macro?.kind).toBe("function");
    expect(macro?.signature).toBe("macro renderButton(label, url)");
    expect(macro?.startLine).toBe(1);
    expect(macro?.endLine).toBe(3); // {% endmacro %}

    const block = parsed.symbols.find((s) => s.name === "content");
    expect(block?.kind).toBe("component");
    expect(block?.startLine).toBe(5);
  });

  it("captures include / extends / import / from paths as imports", () => {
    const src = [
      '{% extends "./base.html" %}',
      '{% include "./partials/header.html" %}',
      '{% import "./macros.html" as m %}',
      '{% from "./forms.html" import field %}',
    ].join("\n");
    const parsed = parseHubL(wf("page.html", src), src);
    expect(parsed.imports.sort()).toEqual(
      ["./base.html", "./forms.html", "./macros.html", "./partials/header.html"].sort(),
    );
  });

  it("tolerates whitespace-control tags ({%- ... -%})", () => {
    const src = "{%- macro spaced() -%}\nx\n{%- endmacro -%}";
    const parsed = parseHubL(wf("m.html", src), src);
    expect(parsed.symbols.map((s) => s.name)).toEqual(["spaced"]);
  });

  it("yields nothing for plain HTML (no HubL tags)", () => {
    const src = '<div class="filter-bar"><p>hello</p></div>';
    const parsed = parseHubL(wf("plain.html", src), src);
    expect(parsed.symbols).toEqual([]);
    expect(parsed.imports).toEqual([]);
  });
});

describe("HubL include → import edge", () => {
  it("resolves a relative include to an imports edge in the graph", async () => {
    const pageSrc = '{% include "./partials/header.html" %}\n{% include "external/missing.html" %}';
    const headerSrc = "{% macro h() %}x{% endmacro %}";

    const page: ParsedFile = parseHubL(wf("page.html", pageSrc), pageSrc);
    const header: ParsedFile = parseHubL(wf("partials/header.html", headerSrc), headerSrc);

    const graph = await buildGraph(".", [page, header]);

    const importEdges = graph.edges.filter((e) => e.kind === "imports");
    expect(importEdges).toContainEqual({
      from: "file:page.html",
      to: "file:partials/header.html",
      kind: "imports",
    });
    // The non-relative "external/missing.html" must NOT produce an edge.
    expect(importEdges).toHaveLength(1);

    // header's macro is indexed as a symbol.
    const macroNode = graph.nodes.find((n) => n.kind === "symbol" && n.name === "h");
    expect(macroNode).toBeDefined();
  });
});
