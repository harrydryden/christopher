/**
 * Lighthouse CI against a production build of the interface, signed in.
 *
 *   pnpm --filter @col/web build
 *   DATABASE_URL=postgres://… node scripts/perf/lighthouse.mjs [--mobile-only | --desktop-only]
 *
 * `--preview <deployment-url>` instead measures `/login`, signed out, on a Vercel preview, warnings
 * only, with VERCEL_AUTOMATION_BYPASS_SECRET as the protection bypass; it touches no database.
 *
 * CHROME_PATH picks the browser; LHCI_CHROME_FLAGS adds flags (`--no-sandbox` when running as root).
 *
 * Seeds the way scripts/smoke-web.mjs does: a disposable administrator (`lhci@col.invalid`) with one
 * session row and the HMAC cookie apps/web/lib/session.ts expects, a throwaway company it follows
 * with one role, a Library and one CV, so `/`, `/companies`, `/library` and `/cv/<id>` render what a
 * signed-in person sees. Starts `next start` on LHCI_PORT (3124), runs `lhci autorun` with the
 * committed `lighthouserc.json` (desktop, three runs, median-run assertions: errors fail), then the
 * same URLs on Lighthouse's default mobile emulation with every assertion lowered to a warning until
 * there is a baseline. The account, its company and the server go in a `finally`, whatever happened.
 *
 * The cookie reaches Chrome only as `extraHeaders` in a config written to a temporary directory; it
 * is not printed and not in any report Lighthouse uploads (reports go to `lighthouse-reports/`).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { disposableAdmin, startWeb } from "../lib/web.mjs";

export const LHCI_EMAIL = "lhci@col.invalid";
export const LHCI_DOMAIN = "lhci.invalid";
const ROOT = new URL("../../", import.meta.url);

/**
 * The committed config with the seeded ids and cookie filled in: `${DRAFT_ID}` in every URL, the
 * port if it differs, and the cookie as a request header Lighthouse sends with every request. Pure.
 */
export function signedInConfig(base, { draftId, cookie, port = 3124, chromeFlags }) {
  const config = structuredClone(base);
  // Only where Chrome needs telling: a local run as root needs --no-sandbox, a CI runner does not.
  if (chromeFlags) config.ci.collect.settings = { ...config.ci.collect.settings, chromeFlags };
  const origin = `http://127.0.0.1:${port}`;
  config.ci.collect.url = config.ci.collect.url.map(url => url.replace("${DRAFT_ID}", draftId).replace("http://127.0.0.1:3124", origin));
  config.ci.collect.settings = { ...config.ci.collect.settings, extraHeaders: JSON.stringify({ cookie }) };
  if (port !== 3124) {
    for (const entry of config.ci.assert.assertMatrix ?? []) entry.matchingUrlPattern = entry.matchingUrlPattern.replace("3124", String(port));
  }
  return config;
}

/**
 * The mobile pass: Lighthouse's default emulation (a mid-range phone, 4x CPU slowdown) in place of
 * the desktop preset, and every assertion a warning, so it reports without failing until two weeks
 * of history say what to hold it to. Pure.
 */
export function mobileConfig(desktop) {
  const config = structuredClone(desktop);
  const { preset: _desktop, ...settings } = config.ci.collect.settings;
  config.ci.collect.settings = settings;
  for (const entry of config.ci.assert.assertMatrix ?? [{ assertions: config.ci.assert.assertions }]) {
    for (const [audit, rule] of Object.entries(entry.assertions)) entry.assertions[audit] = ["warn", rule[1]];
  }
  if (config.ci.upload?.outputDir) config.ci.upload.outputDir = config.ci.upload.outputDir.replace(/desktop$/, "mobile");
  return config;
}

export { sessionCookie } from "../lib/web.mjs";

async function seed(pool, secret) {
  const { userId, cookie, companyId } = await disposableAdmin(pool, {
    email: LHCI_EMAIL, name: "Lighthouse", domain: LHCI_DOMAIN, companyName: "Lighthouse Company", secret, userAgent: "lighthouse-ci" });
  const { rows: [source] } = await pool.query("insert into career_sources (company_id, type, url, status) values ($1, 'greenhouse', 'https://lhci.invalid/careers', 'active') returning id", [companyId]);
  const { rows: [job] } = await pool.query(
    `insert into jobs (company_id, source_id, external_key, title, normalized_title, url, location, locations, description_text)
     values ($1, $2, 'lhci-1', 'Engineering Manager', 'engineering manager', 'https://lhci.invalid/jobs/1', 'London, UK', '["London, UK"]'::jsonb, repeat('Engineering work with measurable outcomes. ', 60))
     returning id, title, description_text`, [companyId, source.id]);
  await pool.query("insert into user_jobs (user_id, job_id, in_table, keyword_matched, location_ok, fit_score, score_state) values ($1, $2, true, true, true, 78, 'scored')", [userId, job.id]);
  const library = { name: "Lighthouse", contact: LHCI_EMAIL, profile: "Engineering leader focused on reliable delivery. ".repeat(20),
    entries: [{ id: "experience-1", kind: "experience", heading: "Engineering leadership — Example Co", company: "Example Co", details: "Led delivery and improved throughput by 25%.\n".repeat(20) }] };
  await pool.query("insert into cv_libraries (user_id, version, content) values ($1, 1, $2)", [userId, library]);
  const content = { name: "Lighthouse", contact: LHCI_EMAIL, summary: "Engineering leader focused on reliable delivery.",
    sections: [{ entryId: "experience-1", kind: "experience", heading: "Engineering leadership — Example Co", bullets: ["Led delivery and improved throughput by 25%."] }], gaps: [] };
  const { rows: [draft] } = await pool.query(
    `insert into cv_drafts (user_id, job_id, job_title, company_name, job_description, library_version, library_snapshot, model, status, content)
     values ($1, $2, $3, 'Lighthouse Company', $4, 1, $5, 'lighthouse-fixture', 'ready', $6) returning id`,
    [userId, job.id, job.title, job.description_text, library, content]);
  return { draftId: draft.id, cookie };
}

async function removeSeed(pool) {
  // The account takes its session, subscription, Library and CV with it; the company its source and role.
  await pool.query("delete from users where email = $1", [LHCI_EMAIL]);
  await pool.query("delete from companies where domain = $1", [LHCI_DOMAIN]);
}

function run(command, args, env) {
  return new Promise(resolveRun => {
    const child = spawn(command, args, { stdio: "inherit", env, cwd: ROOT });
    child.on("exit", code => resolveRun(code ?? 1));
    child.on("error", () => resolveRun(1));
  });
}

/**
 * The second pass, on a Vercel preview deployment: `/login` signed out, because no preview database
 * is documented and a session row must never be written to production. The protection-bypass
 * header gets past Vercel's deployment protection; every assertion is a warning, since the preview's
 * numbers include the edge and the region, which the local server's do not. Pure.
 */
export function previewConfig(desktop, { url, bypass }) {
  const config = mobileConfig(desktop);
  config.ci.collect.settings = { ...desktop.ci.collect.settings };
  delete config.ci.collect.settings.extraHeaders;
  if (bypass) config.ci.collect.settings.extraHeaders = JSON.stringify({ "x-vercel-protection-bypass": bypass, "x-vercel-set-bypass-cookie": "true" });
  const origin = new URL(url).origin;
  config.ci.collect.url = [`${origin}/login`];
  config.ci.assert = { assertions: { ...config.ci.assert.assertMatrix.at(-1).assertions } };
  config.ci.upload.outputDir = "lighthouse-reports/preview";
  return config;
}

async function preview(url) {
  const lhci = createRequire(new URL("../../package.json", import.meta.url)).resolve("@lhci/cli/src/cli.js");
  const dir = mkdtempSync(join(tmpdir(), "col-lhci-"));
  try {
    const base = JSON.parse(readFileSync(new URL("lighthouserc.json", ROOT), "utf8"));
    const path = join(dir, "lighthouserc.preview.json");
    writeFileSync(path, JSON.stringify(previewConfig(base, { url, bypass: process.env.VERCEL_AUTOMATION_BYPASS_SECRET })), { mode: 0o600 });
    process.exitCode = await run(process.execPath, [lhci, "autorun", `--config=${path}`], process.env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const previewAt = process.argv.indexOf("--preview");
  if (previewAt >= 0) return preview(process.argv[previewAt + 1] ?? "");
  const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
  const { Pool } = require("pg");
  const lhci = createRequire(new URL("../../package.json", import.meta.url)).resolve("@lhci/cli/src/cli.js");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const port = Number(process.env.LHCI_PORT ?? 3124);
  const secret = `lighthouse-${randomBytes(24).toString("hex")}`;
  const passes = process.argv.includes("--mobile-only") ? ["mobile"] : process.argv.includes("--desktop-only") ? ["desktop"] : ["desktop", "mobile"];
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const dir = mkdtempSync(join(tmpdir(), "col-lhci-"));
  let web;
  let exitCode = 0;
  try {
    const { draftId, cookie } = await seed(pool, secret);
    const env = { ...process.env, DATABASE_URL: databaseUrl, SESSION_SECRET: secret, NODE_ENV: "production", PORT: String(port) };
    web = await startWeb({ port, env, intervalMs: 1_000, stdio: ["ignore", "ignore", "inherit"] });
    const desktop = signedInConfig(JSON.parse(readFileSync(new URL("lighthouserc.json", ROOT), "utf8")), { draftId, cookie, port, chromeFlags: process.env.LHCI_CHROME_FLAGS });
    for (const pass of passes) {
      const path = join(dir, `lighthouserc.${pass}.json`);
      writeFileSync(path, JSON.stringify(pass === "desktop" ? desktop : mobileConfig(desktop)), { mode: 0o600 });
      console.log(`\nLighthouse, ${pass}${pass === "mobile" ? " (warnings only)" : ""}`);
      const code = await run(process.execPath, [lhci, "autorun", `--config=${path}`], env);
      if (code !== 0 && pass === "desktop") exitCode = code;
    }
  } finally {
    await web?.stop();
    await removeSeed(pool).catch(error => { console.error(`could not remove the Lighthouse account: ${error.message}`); exitCode ||= 1; });
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  }
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
