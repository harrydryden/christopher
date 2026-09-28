/** Authenticated, read-only application smoke for a retained synthetic restore. */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { localDatabaseUrl } from "./lib/database.mjs";
import { insertSession, startWeb } from "./lib/web.mjs";

const EXPECTED_DB = "christopher_recovery_drill";
export const validateSmokeUrl = raw => localDatabaseUrl(raw, { name: EXPECTED_DB, message: `recovery smoke requires local database ${EXPECTED_DB}` });

async function main() {
  const url = validateSmokeUrl(process.env.RECOVERY_TARGET_URL ?? "");
  const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: url.href, max: 1 });
  const secret = "local-recovery-read-smoke-0123456789abcdef0123456789abcdef";
  const port = Number(process.env.RECOVERY_SMOKE_PORT ?? 3141);
  const { rows: [user] } = await pool.query(`select id from users where claimed_at is not null order by created_at limit 1`);
  if (!user) throw new Error("restored synthetic database has no claimed account");
  const sessionId = randomUUID();
  const { cookie } = await insertSession(pool, user.id, { secret, ttlSeconds: 900, userAgent: "local recovery read smoke", id: sessionId, ipAddress: "127.0.0.1" });
  const failures = [], pages = [];
  let web;
  try {
    web = await startWeb({ port, env: { DATABASE_URL: url.href, SESSION_SECRET: secret }, probeTimeoutMs: 1000, logLimit: 8000 });
    for (const path of ["/", "/companies", "/applications", "/library", "/api/work-status"]) {
      const started = performance.now();
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(10_000) });
      const body = await response.text();
      pages.push({ path, status: response.status, bytes: body.length, ms: +((performance.now() - started)).toFixed(1) });
      if (response.status !== 200 || /Internal Server Error|Application error/.test(body)) failures.push(`${path}: HTTP ${response.status}`);
    }
    await pool.query("delete from sessions where id=$1", [sessionId]);
    const revokedResponse = await fetch(`http://127.0.0.1:${port}/api/work-status`, { headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    const revokedBody = await revokedResponse.text();
    const revokedSession = { status: revokedResponse.status, cacheControl: revokedResponse.headers.get("cache-control"), body: revokedBody };
    if (revokedResponse.status !== 401) failures.push(`revoked session /api/work-status: HTTP ${revokedResponse.status}, expected 401`);
    if (!revokedSession.cacheControl?.split(/\s*,\s*/).includes("no-store")) failures.push(`revoked session /api/work-status: cache-control ${revokedSession.cacheControl}, expected no-store`);
    const report = { at: new Date().toISOString(), passed: failures.length === 0, failures, blocker: null, database: EXPECTED_DB, authenticated: failures.length === 0,
      readOnlyJourney: true, fixtureSetup: { insertedDedicatedSession: true, sessionRemovedAfterJourney: true }, pages, revokedSession,
      limitations: ["The application journey issues GET requests only. Setup inserts one short-lived session for an existing synthetic account and cleanup removes it.", "This is local application compatibility evidence, not hosted RTO or production-data validation."] };
    await writeFile(process.env.RECOVERY_SMOKE_REPORT_PATH ?? "/tmp/recovery-read-smoke.json", JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
    if (!report.passed) process.exitCode = 1;
  } finally {
    await pool.query("delete from sessions where id=$1", [sessionId]).catch(() => undefined);
    await pool.end();
    await web?.stop({ graceMs: 5000 });
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) await main();
