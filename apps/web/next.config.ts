import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.resolve(__dirname, "../.."),
  transpilePackages: ["@christopher/db", "@christopher/core", "@christopher/ai", "@christopher/worker"],
  // `pg` and the Anthropic SDK are CommonJS-friendly server packages; Playwright is only reachable
  // through a dynamic import that a serverless deployment never takes, so it must not be bundled.
  serverExternalPackages: ["pdfkit","pg", "playwright", "playwright-core", "@anthropic-ai/sdk"],
};

export default nextConfig;
