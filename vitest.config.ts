import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      // Hook scripts are imported as text (tsup does this via its loader
      // config); mirror that here so any test can import modules that pull in
      // installer.ts / start-claude.ts without a parse failure.
      name: "raw-hook-scripts",
      enforce: "pre",
      transform(code, id) {
        if (id.endsWith(".ps1") || id.endsWith(".sh")) {
          return { code: `export default ${JSON.stringify(code)};`, map: null };
        }
      },
    },
  ],
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // Report every source file (not just those a test touches) so untested
      // areas — e.g. the walker/parser-dispatch gap — show up as 0%.
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/dashboard/public/**"],
    },
  },
});
