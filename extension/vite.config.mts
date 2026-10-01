// The large panel's page: one fixed-name JS + CSS pair in dist/webview/, which
// the host loads through asWebviewUri under a nonce CSP (src/html.ts). The
// extension host itself is bundled separately by esbuild.
import { resolve } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const root = import.meta.dirname;

export default defineConfig({
  // Required: the default "/" emits url(/assets/…), which 404s inside a webview.
  base: "./",
  plugins: [svelte()],
  build: {
    outDir: resolve(root, "dist/webview"),
    emptyOutDir: true,
    // VS Code 1.75 — the engine floor — runs webviews on Chromium 102.
    target: "chrome102",
    cssCodeSplit: false,
    modulePreload: false,
    reportCompressedSize: false,
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: resolve(root, "src/webview/main.ts"),
      output: {
        format: "es",
        codeSplitting: false,
        entryFileNames: "webview.js",
        assetFileNames: (a) =>
          a.names?.[0]?.endsWith(".css") ? "webview.css" : "assets/[name][extname]",
      },
    },
  },
});
