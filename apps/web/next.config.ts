import type { NextConfig } from "next";
import path from "node:path";

// pdfkit loads each standard font's metrics with a runtime `require("standard-fonts/<Name>")`.
// File tracing cannot follow that, so those modules were pruned out of the deployed function and
// every PDF download failed with MODULE_NOT_FOUND on Helvetica. The glob covers the chunks/
// subdirectory too, which the font modules share. Both entry points that render a PDF need it:
// the download route, and the page whose server action freezes a PDF onto an application.
// Include only real files in pnpm's store. The app's node_modules/pdfkit is a symlink;
// tracing its children as well produces an invalid Vercel function deployment package.
const PDFKIT_STANDARD_FONTS = [
  "../../node_modules/.pnpm/pdfkit@*/node_modules/pdfkit/js/standard-fonts/**",
];

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.resolve(__dirname, "../.."),
  transpilePackages: ["@christopher/db", "@christopher/core", "@christopher/ai", "@christopher/worker"],
  // `pg` and the Anthropic SDK are CommonJS-friendly server packages; Playwright is only reachable
  // through a dynamic import that a serverless deployment never takes, so it must not be bundled.
  serverExternalPackages: ["pdfkit","pg", "playwright", "playwright-core", "@anthropic-ai/sdk"],
  outputFileTracingIncludes: {
    "/api/cv/[id]/pdf": PDFKIT_STANDARD_FONTS,
    "/cv/[id]": PDFKIT_STANDARD_FONTS,
  },
};

export default nextConfig;
