import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    include: ["app/**/*.test.ts", "lib/**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
    environment: "node",
    // Password hashing at production cost would dominate the account tests; the old cost is plenty here.
    env: { AVA_SCRYPT_N: "16384" },
    // Long enough for a loaded CI machine, short enough that a hung pool or a missing resolve names
    // its test inside the job's budget. A case that needs longer says so, and why, beside it.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    slowTestThreshold: 10_000,
    fileParallelism: false,
  },
});
