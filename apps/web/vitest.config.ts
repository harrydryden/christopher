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
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
