/** Exercise the release against the explicitly isolated managed recovery copy. Never starts a worker. */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { coreIntegritySql } from './recovery-drill.mjs';
import { insertSession, startWeb } from './lib/web.mjs';

export function validateManagedRecoveryUrl(raw) {
  const url = new URL(raw.trim());
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || url.hostname !== 'dpg-danq11ijnfac739fekdg-a.frankfurt-postgres.render.com'
    || url.pathname !== '/christopher_db_niri'
    || (url.port && url.port !== '5432') || url.searchParams.has('port'))
    throw new Error('This drill only permits the named isolated recovery copy on direct port 5432');
  return url;
}

async function main() {
  const started = performance.now();
  const url = validateManagedRecoveryUrl(await readFile(process.env.RECOVERY_URL_FILE ?? '/tmp/col-managed-recovery-url', 'utf8'));
  const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url.href, ssl: { rejectUnauthorized: false }, max: 1, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 });
  const secret = randomUUID(), sessionId = randomUUID();
  const port = 3142;
  let web;
  const failures = [], pages = [];
  let before, after, migrationMs, gapColumn, revokedStatus, sessionRemoved = false;
  try {
    ({ rows: [{ result: before }] } = await pool.query(coreIntegritySql()));
    if (Object.values(before.orphans).some(Number) || Number(before.invalidConstraints)) throw new Error('Recovery baseline integrity failed');
    const migrateStarted = performance.now();
    await new Promise((resolve, reject) => {
      const child = spawn('pnpm', ['db:migrate'], { env: { ...process.env, DATABASE_URL: url.href }, stdio: ['ignore', 'pipe', 'pipe'] });
      // Omit credential-bearing diagnostics; report the exit status only.
      child.stdout.resume(); child.stderr.resume();
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Migration exited ${code}`)));
    });
    migrationMs = Math.round(performance.now() - migrateStarted);
    ({ rows: [gapColumn] } = await pool.query("select data_type,is_nullable from information_schema.columns where table_schema='public' and table_name='cv_drafts' and column_name='gap_quiz'"));
    if (gapColumn?.data_type !== 'jsonb' || gapColumn?.is_nullable !== 'YES') throw new Error('Quiz migration is missing or incompatible');
    const { rows: [user] } = await pool.query('select id from users where claimed_at is not null order by created_at limit 1');
    if (!user) throw new Error('Recovery copy has no claimed account');
    const { cookie } = await insertSession(pool, user.id, { secret, ttlSeconds: 900, userAgent: 'isolated managed recovery smoke', id: sessionId, ipAddress: '127.0.0.1' });
    // The server's output is discarded, never kept: it could carry the recovery copy's credentials.
    web = await startWeb({ port, host: '127.0.0.1', env: { DATABASE_URL: url.href, SESSION_SECRET: secret, COL_SERVERLESS_FALLBACK: '0' },
      probeTimeoutMs: 1000, logLimit: 0 });
    for (const path of ['/', '/companies', '/applications', '/library', '/api/work-status', '/admin/health']) {
      const at = performance.now();
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { cookie }, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
      const body = await response.text();
      pages.push({ path, status: response.status, bytes: body.length, ms: Math.round(performance.now() - at) });
      if (response.status !== 200 || /Internal Server Error|Application error/.test(body)) failures.push(`${path}: HTTP ${response.status}`);
    }
    await pool.query('delete from sessions where id=$1', [sessionId]); sessionRemoved = true;
    const revoked = await fetch(`http://127.0.0.1:${port}/api/work-status`, { headers: { cookie }, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    revokedStatus = revoked.status;
    if (revokedStatus !== 401 || !revoked.headers.get('cache-control')?.includes('no-store')) failures.push('Revoked session was not rejected privately');
    ({ rows: [{ result: after }] } = await pool.query(coreIntegritySql()));
    const withoutMigration = ({ migrationCount, ...rest }) => rest;
    if (JSON.stringify(withoutMigration(before)) !== JSON.stringify(withoutMigration(after))) failures.push('Application data counts/fingerprint/integrity changed');
  } finally {
    await pool.query('delete from sessions where id=$1', [sessionId]).then(() => { sessionRemoved = true; }).catch(() => {});
    await pool.end();
    await web?.stop({ graceMs: 1000 });
  }
  const report = { at: new Date().toISOString(), passed: failures.length === 0, failures, recoveryDatabaseId: 'dpg-danq11ijnfac739fekdg-a',
    releaseCommit: process.env.RELEASE_SHA ?? null, elapsedSeconds: +((performance.now() - started) / 1000).toFixed(2), migrationMs, gapColumn,
    before, after, pages, revokedStatus, sessionRemoved, productionOriginalTouched: false, workerStarted: false,
    limitations: ['Application ran locally against the isolated managed database, not as a hosted web/worker pair.',
      'This follow-up does not measure incident-to-restoration RTO, prove historical RPO, or exercise a live worker rollback.',
      'Application requests were read-only; setup applied the additive migration and created then removed one dedicated session.'] };
  await writeFile(process.env.RECOVERY_SMOKE_REPORT_PATH ?? 'docs/benchmarks/managed-application-recovery-2026-09-20.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, elapsedSeconds: report.elapsedSeconds, pages, failures, sessionRemoved }));
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
