// JS/TS symbol-extraction diagnosis + regression (the "0 symbols on server.js"
// dogfood MISS). Confirms which forms the parser captures and pins the fix for
// CommonJS member-export functions.

import { describe, it, expect } from "vitest";

import { parseTypeScript } from "../src/scanner/parsers/typescript.js";
import type { WalkedFile } from "../src/scanner/walker.js";

function wf(relPath: string): WalkedFile {
  return { absPath: "/proj/" + relPath, relPath, ext: relPath.slice(relPath.lastIndexOf(".")), size: 0 };
}

async function symbolNames(relPath: string, src: string): Promise<string[]> {
  const parsed = await parseTypeScript(wf(relPath), src);
  return parsed.symbols.map((s) => s.name).sort();
}

describe("JS parser symbol extraction", () => {
  it("extracts nothing from a pure-wiring server.js (inline-callback args, no named defs)", async () => {
    const src = [
      "const express = require('express');",
      "const app = express();",
      "app.get('/', (req, res) => res.send('hi'));",
      "io.on('connection', (socket) => { socket.emit('x'); });",
      "server.listen(3000, () => console.log('up'));",
    ].join("\n");
    // This is the dogfood case — genuinely symbol-less, so a whole-file read is
    // the correct answer (the gate's symbol-hit guard already avoids blocking it).
    expect(await symbolNames("server.js", src)).toEqual([]);
  });

  it("captures declarations, const arrows, classes, AND CommonJS member exports", async () => {
    const src = [
      "function helper(x) { return x + 1; }",
      "const compute = (a) => a * 2;",
      "class Widget {}",
      "exports.handler = function (req) { return req; };",
      "module.exports.route = (req, res) => res.end();",
    ].join("\n");
    const names = await symbolNames("mod.js", src);
    expect(names).toContain("helper");
    expect(names).toContain("compute");
    expect(names).toContain("Widget");
    // The fix: CommonJS member-export functions are now captured.
    expect(names).toContain("handler");
    expect(names).toContain("route");
  });
});
