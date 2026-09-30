import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    // Embedded PGlite boots in a few seconds (more on a cold start with parallel test files).
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
