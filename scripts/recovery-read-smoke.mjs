/** Authenticated, read-only application smoke for a retained synthetic restore. */
import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";

const EXPECTED_DB = "christopher_recovery_drill";
export function validateSmokeUrl(raw) {
  const url = new URL(raw);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || decodeURIComponent(url.pathname.slice(1)) !== EXPECTED_DB)
    throw new Error(`recovery smoke requires local database ${EXPECTED_DB}`);
  return url;
}

async function main() {
  const url = validateSmokeUrl(process.env.RECOVERY_TARGET_URL ?? "");
  const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: url.href, max: 1 });
  const secret = "local-recovery-read-smoke";
  const port = Number(process.env.RECOVERY_SMOKE_PORT ?? 3141);
  const { rows: [user] } = await pool.query(`select id from users where claimed_at is not null order by created_at limit 1`);
  if (!user) throw new Error("restored synthetic database has no claimed account");
  const expires = Math.floor(Date.now() / 1000) + 900;
  const sessionId = randomUUID();
  await pool.query(`insert into sessions(id,user_id,expires_at,user_agent,ip_address) values($1,$2,to_timestamp($3),'local recovery read smoke','127.0.0.1')`, [sessionId, user.id, expires]);
  const cookie = `ava_session=v2.${sessionId}.${expires}.${createHmac("sha256", secret).update(`${sessionId}.${expires}`).digest("base64url")}`;
  const server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "-p", String(port)], {
    cwd: new URL("../apps/web", import.meta.url), detached: true,
    env: { ...process.env, DATABASE_URL: url.href, SESSION_SECRET: secret, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = ""; server.stdout.on("data", b => { log = (log + b).slice(-8000); }); server.stderr.on("data", b => { log = (log + b).slice(-8000); });
  const failures = [], pages = [];
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error(`web application did not start: ${log}`);
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
    server.kill("SIGTERM");
    await Promise.race([once(server, "exit"), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
    try { process.kill(-server.pid, "SIGKILL"); } catch {}
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) await main();
