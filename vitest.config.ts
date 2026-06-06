import { defineConfig } from "vitest/config";

export default defineConfig({
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
