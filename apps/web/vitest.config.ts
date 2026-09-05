import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    include: ["app/**/*.test.ts", "lib/**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
