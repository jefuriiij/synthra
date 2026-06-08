// Parser dispatch + per-language smoke tests. Each case writes a tiny source
// file and runs the real parseFile() entry point — proving the extension routes
// to the right parser, the (tree-sitter) grammar loads, and at least the obvious
// symbol is extracted. Assertions are intentionally loose: this is a regression
// net against broken grammars (cf. the Dart ABI bug), not a conformance suite.

import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import { parseFile } from "../src/scanner/parser.js";

interface Case {
  lang: string;
  file: string;
  src: string;
  symbols: string[];
  imports?: string[];
}

const CASES: Case[] = [
  {
    lang: "typescript",
    file: "a.ts",
    src: 'import { helper } from "./helper";\nexport class AuthService {\n  login() {\n    return helper();\n  }\n}\n',
    symbols: ["AuthService", "login"],
    imports: ["./helper"],
  },
  {
    lang: "tsx",
    file: "a.tsx",
    src: "export function Widget() {\n  return null;\n}\n",
    symbols: ["Widget"],
  },
  {
    lang: "python",
    file: "a.py",
    src: "class Greeter:\n    def hello(self):\n        return 1\n",
    symbols: ["Greeter", "hello"],
  },
  {
    lang: "go",
    file: "a.go",
    src: 'package main\n\nfunc Hello() string {\n  return "hi"\n}\n',
    symbols: ["Hello"],
  },
  {
    lang: "rust",
    file: "a.rs",
    src: "pub fn hello() -> i32 {\n  1\n}\n\npub struct Widget {\n  x: i32,\n}\n",
    symbols: ["hello", "Widget"],
  },
  {
    lang: "java",
    file: "A.java",
    src: "public class Greeter {\n  public void hello() {}\n}\n",
    symbols: ["Greeter", "hello"],
  },
  {
    lang: "kotlin",
    file: "A.kt",
    src: "class Greeter {\n  fun hello() {}\n}\n",
    symbols: ["Greeter", "hello"],
  },
  {
    lang: "php",
    file: "a.php",
    src: "<?php\nclass Greeter {\n  public function hello() {}\n}\n",
    symbols: ["Greeter", "hello"],
  },
  {
    lang: "ruby",
    file: "a.rb",
    src: "class Greeter\n  def hello\n  end\nend\n",
    symbols: ["Greeter", "hello"],
  },
  {
    lang: "c",
    file: "a.c",
    src: "int add(int a, int b) {\n  return a + b;\n}\n",
    symbols: ["add"],
  },
  {
    lang: "cpp",
    file: "a.cpp",
    src: "class Greeter {\npublic:\n  void hello();\n};\n",
    symbols: ["Greeter"],
  },
  {
    lang: "csharp",
    file: "A.cs",
    src: "public class Greeter {\n  public void Hello() {}\n}\n",
    symbols: ["Greeter", "Hello"],
  },
  {
    lang: "dart",
    file: "a.dart",
    src: "class Greeter {\n  void hello() {}\n}\n",
    symbols: ["Greeter", "hello"],
  },
  {
    lang: "svelte",
    file: "A.svelte",
    src: "<script>\n  export function greet() {}\n</script>\n<div>hi</div>\n",
    symbols: ["greet"],
  },
  {
    lang: "vue",
    file: "A.vue",
    src: "<script>\nexport function greet() {}\n</script>\n<template><div /></template>\n",
    symbols: ["greet"],
  },
  {
    lang: "hubl",
    file: "a.html",
    src: "{% macro greet(name) %}hi {{ name }}{% endmacro %}\n",
    symbols: ["greet"],
  },
];

describe("parseFile dispatch + per-language smoke", () => {
  for (const c of CASES) {
    it(`routes + extracts symbols for ${c.lang}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "syn-parse-"));
      const absPath = join(dir, c.file);
      await writeFile(absPath, c.src, "utf8");

      const parsed = await parseFile({
        absPath,
        relPath: c.file,
        ext: extname(c.file).toLowerCase(),
        size: c.src.length,
      });

      const names = parsed.symbols.map((s) => s.name);
      for (const sym of c.symbols) expect(names).toContain(sym);
      for (const imp of c.imports ?? []) expect(parsed.imports).toContain(imp);
    });
  }
});
