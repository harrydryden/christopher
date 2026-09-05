import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // These suites share one database and truncate between tests, so they must not run in parallel.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
