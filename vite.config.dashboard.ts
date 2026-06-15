// Dashboard UI build (dev-only). Compiles the Svelte + Tailwind dashboard in
// src/dashboard/ui/ into a SINGLE self-contained index.html (JS+CSS inlined) at
// src/dashboard/built/, which the Hono server (src/dashboard/server.ts) then
// text-imports and serves — exactly like the old hand-written index.html.
// Nothing here ships to npm; svelte/vite/tailwind are all devDependencies.

import { resolve } from "node:path";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const root = import.meta.dirname;

export default defineConfig({
  root: resolve(root, "src/dashboard/ui"),
  plugins: [svelte({ preprocess: vitePreprocess() }), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: { $lib: resolve(root, "src/dashboard/ui/lib") },
  },
  build: {
    outDir: resolve(root, "src/dashboard/built"),
    emptyOutDir: true,
    // singlefile inlines everything; keep the output deterministic.
    cssCodeSplit: false,
    reportCompressedSize: false,
  },
});
