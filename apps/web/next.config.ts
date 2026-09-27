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

/**
 * The one inline script Next writes identically into every page, the flight-data bootstrap. The
 * data chunks that follow it (`self.__next_f.push([1, ...])`) differ per response and cannot be
 * hashed; they are what the report-only policy below still reports, and what must be settled
 * (a nonce, which costs a per-request render, or `'unsafe-inline'`) before it can be enforced.
 */
const NEXT_BOOTSTRAP_SCRIPT_HASH = "'sha256-OBTN3RiyCV4Bq7dFqZ5a2pAXjnCcCYeTJMO2I/LYKeo='";

/**
 * A policy the browser reports against without enforcing it, to learn what a full CSP would break
 * before shipping one. Images allow any https origin and data: because uncaptured company icons
 * fall back to the company's own host and an icon service (`lib/company-icon.ts`); the CV preview
 * frames a blob: PDF; React sets style attributes, so inline styles are allowed.
 */
const REPORT_ONLY_CSP = [
  "default-src 'self'",
  `script-src 'self' ${NEXT_BOOTSTRAP_SCRIPT_HASH}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Static security headers, the same bytes on every response, so they change nothing about what a
 * cache may hold; never add `Vary` beside them. What is enforced is what cannot break a page: no
 * MIME sniffing, no framing by another site, a referrer that stops at the origin, and no access to
 * device features the interface never uses.
 */
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
];

const CONTENT_SECURITY_POLICIES = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Content-Security-Policy-Report-Only", value: REPORT_ONLY_CSP },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      // A header set here replaces the one a route handler sets, so the policies skip the company
      // logo, whose own sandboxing policy (no script, a unique origin) must survive: its bytes are a
      // company's SVG, which would otherwise run in this origin when opened on its own.
      { source: "/:path((?!api/companies/[^/]+/logo$).*)", headers: CONTENT_SECURITY_POLICIES },
      // A share link's URL is its credential: no page it links to may learn it, not even its origin.
      // Listed after the rule above, which Next lets it override.
      { source: "/share/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
    ];
  },
  outputFileTracingRoot: path.resolve(__dirname, "../.."),
  transpilePackages: ["@ava/db", "@ava/core", "@ava/ai", "@ava/worker"],
  // `pg` and the Anthropic SDK are CommonJS-friendly server packages; Playwright is only reachable
  // through a dynamic import that a serverless deployment never takes, so it must not be bundled.
  serverExternalPackages: ["pdfkit","pg", "playwright", "playwright-core", "@anthropic-ai/sdk"],
  experimental: {
    // A Library upload is posted through a server action, and Next refuses any action body over
    // 1 MB before the action runs: a designed CV or a LinkedIn PDF of 1–5 MB failed with a
    // framework error the form could only call a failed send. The action refuses files over
    // `LIBRARY_IMPORT_MAX_BYTES` (5 MB) in a sentence, so the transport allows that much plus the
    // multipart framing and the form's other fields around it.
    serverActions: { bodySizeLimit: "6mb" },
  },
  outputFileTracingIncludes: {
    "/api/cv/[id]/pdf": PDFKIT_STANDARD_FONTS,
    "/api/cv/preview": PDFKIT_STANDARD_FONTS,
    "/cv/[id]": PDFKIT_STANDARD_FONTS,
  },
};

export default nextConfig;
