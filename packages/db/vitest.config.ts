import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The database suites share one database with the worker's and the interface's, so they must not run in parallel.
    fileParallelism: false,
  },
});
