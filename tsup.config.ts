import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "cli/index": "src/cli/index.ts",
    "server/index": "src/server/http.ts",
    "dashboard/index": "src/dashboard/server.ts",
  },
  format: ["esm"],
  outDir: "dist",
  target: "node18",
  platform: "node",
  clean: true,
  minify: false,
  sourcemap: true,
  splitting: false,
  shims: false,
  loader: {
    ".ps1": "text",
    ".sh": "text",
    ".html": "text",
    ".css": "text",
  },
});
