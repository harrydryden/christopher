import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Long enough for a loaded CI machine, short enough that a hang names its test inside the job's
    // budget. A case that needs longer (the end-to-end scans) says so, and why, beside it.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    slowTestThreshold: 10_000,
    // These suites share one database and truncate between tests, so they must not run in parallel.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
