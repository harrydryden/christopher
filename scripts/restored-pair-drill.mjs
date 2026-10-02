/**
 * Local-only compatibility drill: seed one synthetic account, logically restore it, then boot the
 * real web and worker processes against the restored copy. Both named databases are retained.
 * This does not test a managed snapshot, production deployment, RPO or RTO.
 */
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { validateRecoveryUrls, coreIntegritySql } from './recovery-drill.mjs';
import { insertSession, startWeb } from './lib/web.mjs';

const CONTAINER = 'jtbd-90-postgres-20260929';
const EMAIL = 'restored-drill@example.invalid';
const DOMAIN = 'restored-drill.invalid';
const COMPANY = 'Restoration Drill Co';
const ROLE = 'Operations Analyst — Restoration Drill';
const LOCAL = 'http://127.0.0.1:1';
const REPO = fileURLToPath(new URL('..', import.meta.url));

export function validatePairDrillUrls(sourceInput, targetInput, container) {
  const { source, target } = validateRecoveryUrls(sourceInput, targetInput);
  if (source.hostname !== '127.0.0.1' || source.port !== '55439' || source.username !== 'postgres'
    || container !== CONTAINER) {
    throw new Error('Restored pair drill requires the named local Docker PostgreSQL on 127.0.0.1:55439');
  }
  return { source, target };
}

/** Refuse any fixture which could give the live worker external or paid work. */
export function assertSafeFixtureSnapshot(snapshot) {
  const exact = ['users', 'companies', 'subscriptions', 'sources', 'jobs', 'libraries', 'applications', 'tasks'];
  for (const key of exact) if (Number(snapshot[key]) !== 1) throw new Error(`Unsafe recovery fixture: ${key} must equal one`);
  for (const key of ['activeSubscriptions', 'discoverySources', 'discoveryCandidates', 'runnableSources', 'externalUrls', 'otherTasks', 'runningTasks']) {
    if (Number(snapshot[key]) !== 0) throw new Error(`Unsafe recovery fixture: ${key} must equal zero`);
  }
  if (snapshot.email !== EMAIL || snapshot.domain !== DOMAIN || snapshot.companyStatus !== 'paused'
    || snapshot.subscriptionStatus !== 'paused' || snapshot.sourceStatus !== 'disabled'
    || snapshot.taskType !== 'reevaluate_gate' || snapshot.taskStatus !== 'queued' || snapshot.roleVisible !== false
    || snapshot.taskSubject !== snapshot.userId) {
    throw new Error('Unsafe recovery fixture: unexpected identity, active source or task');
  }
  return snapshot;
}

function safeEnvironment(extra = {}) {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'LANG', 'LC_ALL', 'NODE_OPTIONS', 'PNPM_HOME', 'COREPACK_HOME'];
  const env = Object.fromEntries(keep.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  return { ...env, ...extra };
}

function run(command, args, { env = safeEnvironment(), timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${command} timed out`)); }, timeoutMs);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-6000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}: ${output}`));
    });
  });
}

async function fixtureSnapshot(pool) {
  const { rows: [row] } = await pool.query(`select
    (select count(*)::int from users) users,
    (select count(*)::int from companies) companies,
    (select count(*)::int from company_subscriptions) subscriptions,
    (select count(*)::int from career_sources) sources,
    (select count(*)::int from jobs) jobs,
    (select count(*)::int from cv_libraries) libraries,
    (select count(*)::int from applications) applications,
    (select count(*)::int from tasks) tasks,
    (select count(*)::int from company_subscriptions where status='active') "activeSubscriptions",
    (select count(*)::int from discovery_sources) "discoverySources",
    (select count(*)::int from discovery_candidates) "discoveryCandidates",
    (select count(*)::int from career_sources where status='active') "runnableSources",
    (select count(*)::int from companies where homepage_url !~ '^http://127[.]0[.]0[.]1:1/'
      or (favicon_url is not null and favicon_url !~ '^http://127[.]0[.]0[.]1:1/'))
      + (select count(*)::int from career_sources where url !~ '^http://127[.]0[.]0[.]1:1/' )
      + (select count(*)::int from jobs where url !~ '^http://127[.]0[.]0[.]1:1/') "externalUrls",
    (select count(*)::int from tasks where type<>'reevaluate_gate') "otherTasks",
    (select count(*)::int from tasks where status='running') "runningTasks",
    (select email from users limit 1) email,
    (select domain from companies limit 1) domain,
    (select status from companies limit 1) "companyStatus",
    (select status from company_subscriptions limit 1) "subscriptionStatus",
    (select status from career_sources limit 1) "sourceStatus",
    (select id::text from users limit 1) "userId",
    (select in_table from user_jobs limit 1) "roleVisible",
    (select type from tasks limit 1) "taskType",
    (select status from tasks limit 1) "taskStatus",
    (select payload->>'userId' from tasks limit 1) "taskSubject"`);
  return assertSafeFixtureSnapshot(row);
}

async function seedSource(pool) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows: [user] } = await client.query(`insert into users(email,name,claimed_at,email_verified_at)
      values ($1,'Synthetic Candidate',now(),now()) returning id`, [EMAIL]);
    const { rows: [company] } = await client.query(`insert into companies(name,homepage_url,domain,status)
      values ($1,$2,$3,'paused') returning id`, [COMPANY, `${LOCAL}/company`, DOMAIN]);
    await client.query(`insert into company_subscriptions(user_id,company_id,status) values ($1,$2,'paused')`, [user.id, company.id]);
    const { rows: [source] } = await client.query(`insert into career_sources(company_id,type,url,status)
      values ($1,'html',$2,'disabled') returning id`, [company.id, `${LOCAL}/jobs`]);
    const { rows: [job] } = await client.query(`insert into jobs(company_id,source_id,external_key,title,normalized_title,url,location,locations,description_text)
      values ($1,$2,'synthetic-1',$3,'operations analyst restoration drill',$4,'London','["London"]'::jsonb,
        'Synthetic local role used only to verify restore compatibility.') returning id`,
      [company.id, source.id, ROLE, `${LOCAL}/jobs/synthetic-1`]);
    await client.query(`insert into user_jobs(user_id,job_id,keyword_matched,keyword_terms,location_ok,in_table,fit_score,score_state,fit_scored_at,scored_at)
      values ($1,$2,false,'[]'::jsonb,true,false,78,'scored',now(),now())`, [user.id, job.id]);
    await client.query(`insert into cv_libraries(user_id,version,content) values ($1,1,$2::jsonb)`,
      [user.id, JSON.stringify({ name: 'Synthetic Candidate', contact: EMAIL, profile: 'Local restore compatibility fixture.', entries: [] })]);
    await client.query(`insert into applications(user_id,job_id,job_title,company_name,applied_on,status,notes,history)
      values ($1,$2,$3,$4,current_date::text,'applied','Synthetic local application',
        jsonb_build_array(jsonb_build_object('status','applied','at',now()::text,'notes','Synthetic local application')))`,
      [user.id, job.id, ROLE, COMPANY]);
    await client.query(`insert into user_settings(user_id,key,value) values
      ($1,'gate',$2::jsonb),($1,'suggestionsEnabled','false'::jsonb)`, [user.id,
      JSON.stringify({ includeKeywords: ['operations'], excludeKeywords: [], matchFields: ['title'], locationTerms: [], includeRemote: true })]);
    const today = new Date().toISOString().slice(0, 10);
    await client.query(`insert into settings(key,value) values
      ('timezone','"UTC"'::jsonb),('scanTime','"23:59"'::jsonb),
      ('internal:lastWeeklyYmd',$1::jsonb)`, [JSON.stringify(today)]);
    await client.query(`insert into scan_runs(run_date,trigger,finished_at) values ($1,'schedule',now())`, [today]);
    await client.query(`insert into tasks(type,payload,dedupe_key,priority)
      values ('reevaluate_gate',jsonb_build_object('userId',$1::text),'restored-pair:gate',1)`, [user.id]);
    await client.query('commit');
    return { userId: user.id, companyId: company.id, jobId: job.id };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally { client.release(); }
}

function startWorker(url, port) {
  const env = safeEnvironment({ DATABASE_URL: url.href, NODE_ENV: 'development', PORT: String(port),
    AVA_DISABLE_BROWSER: '1', DAILY_AI_BUDGET_USD: '0', DISCOVERY_AI_BUDGET_USD: '0',
    WORKER_CONCURRENCY: '1', CV_CONCURRENCY: '1', SCAN_SPREAD_MINUTES: '0',
    RENDER_INSTANCE_ID: `restored-pair-${process.pid}`, SCRAPER_CONTACT_EMAIL: EMAIL });
  const child = spawn('pnpm', ['--filter', '@ava/worker', 'start:source'], {
    cwd: REPO, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-6000); });
  const stop = async () => {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { return; }
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(5000)]);
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already stopped */ }
  };
  return { child, stop, log: () => log };
}

async function waitForWorker(port, worker, timeoutMs = 45_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (worker.child.exitCode !== null) throw new Error(`Worker exited before health: ${worker.log()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
      const body = await response.json();
      if (response.ok && body.ok === true) return body;
    } catch { /* starting */ }
    await sleep(250);
  }
  throw new Error(`Worker health timed out: ${worker.log()}`);
}

async function waitForGate(pool, userId, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const { rows } = await pool.query(`select type,status,payload,result,error from tasks order by created_at`);
    if (rows.some(row => row.type !== 'reevaluate_gate')) throw new Error('Worker queued unexpected external or paid work');
    const requested = rows.find(row => row.payload?.userId === userId && row.payload?.reason !== 'boot');
    if (requested?.status === 'done') return { status: requested.status, accounts: requested.result?.accounts,
      changed: requested.result?.outcomes?.[userId]?.changed, taskCount: rows.length };
    if (requested?.status === 'failed') throw new Error(`Real reevaluate_gate handler failed: ${requested.error}`);
    await sleep(250);
  }
  throw new Error('Real reevaluate_gate handler did not complete');
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function portClosed(port, path) {
  try {
    await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(500) });
    return false;
  } catch { return true; }
}

async function main() {
  const started = performance.now();
  const container = process.env.RECOVERY_DOCKER_CONTAINER;
  const { source, target } = validatePairDrillUrls(process.env.RECOVERY_SOURCE_URL ?? '', process.env.RECOVERY_TARGET_URL ?? '', container);
  const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
  const { Pool } = require('pg');
  const maintenance = new URL(source); maintenance.pathname = '/postgres';
  const admin = new Pool({ connectionString: maintenance.href, max: 1 });
  const sourcePool = new Pool({ connectionString: source.href, max: 2 });
  const targetPool = new Pool({ connectionString: target.href, max: 3 });
  const work = await mkdtemp(join(tmpdir(), 'ava-restored-pair-'));
  const restoreReport = join(work, 'restore.json');
  const reportPath = process.env.RECOVERY_PAIR_REPORT_PATH ?? '/tmp/ava-restored-pair-report.json';
  const webPort = Number(process.env.RECOVERY_WEB_PORT ?? 3183);
  const workerPort = Number(process.env.RECOVERY_WORKER_PORT ?? 3184);
  if (![webPort, workerPort].every(n => Number.isSafeInteger(n) && n >= 1024 && n <= 65535) || webPort === workerPort)
    throw new Error('Recovery web/worker ports must be distinct local high ports');
  let worker, web, sessionId, fixtureUserId, report, failure;
  try {
    const provenance = {
      sourceCommit: (await run('git', ['rev-parse', 'HEAD'])).trim(),
      webBuildId: (await readFile(join(REPO, 'apps/web/.next/BUILD_ID'), 'utf8')).trim(),
      drillSha256: await sha256(join(REPO, 'scripts/restored-pair-drill.mjs')),
      workerEntrypointSha256: await sha256(join(REPO, 'apps/worker/src/index.ts')),
      gateHandlerSha256: await sha256(join(REPO, 'apps/worker/src/handlers/learning.ts')),
    };
    const { rows: existing } = await admin.query(`select datname from pg_database where datname = any($1::text[])`,
      [['christopher_users_benchmark', 'christopher_recovery_drill']]);
    if (existing.length) throw new Error(`Refusing existing recovery database(s): ${existing.map(row => row.datname).join(', ')}`);
    await run('docker', ['exec', container, 'createdb', '-U', 'postgres', 'christopher_users_benchmark']);
    await run('pnpm', ['db:migrate'], { env: safeEnvironment({ DATABASE_URL: source.href }) });
    const ids = await seedSource(sourcePool);
    fixtureUserId = ids.userId;
    await fixtureSnapshot(sourcePool);
    const { rows: [{ result: before }] } = await sourcePool.query(coreIntegritySql());
    await run('node', ['scripts/recovery-drill.mjs'], { env: safeEnvironment({
      RECOVERY_SOURCE_URL: source.href, RECOVERY_TARGET_URL: target.href,
      RECOVERY_DOCKER_CONTAINER: container, RECOVERY_REPORT_PATH: restoreReport,
    }), timeoutMs: 300_000 });
    const restored = JSON.parse(await readFile(restoreReport, 'utf8'));
    if (!restored.passed) throw new Error('Logical restore failed its integrity comparison');
    await fixtureSnapshot(targetPool);
    const { rows: [{ result: afterRestore }] } = await targetPool.query(coreIntegritySql());
    if (JSON.stringify(before) !== JSON.stringify(afterRestore)) throw new Error('Restored account integrity differs before worker start');
    const secret = randomUUID() + randomUUID();
    const session = await insertSession(targetPool, ids.userId, { secret, ttlSeconds: 900, userAgent: 'local restored pair drill' });
    sessionId = session.id;
    worker = startWorker(target, workerPort);
    const health = await waitForWorker(workerPort, worker);
    const gate = await waitForGate(targetPool, ids.userId);
    if (gate.accounts !== 1 || gate.changed !== 1) throw new Error('Real re-evaluation did not admit the restored role');
    const { rows: [heartbeat] } = await targetPool.query(`select value from settings where key='internal:workerHeartbeat'`);
    if (heartbeat?.value?.workerId !== `restored-pair-${process.pid}`) throw new Error('Real worker heartbeat missing from restored database');
    const { rows: [account] } = await targetPool.query(`select u.email,c.name company,j.title role,l.version library_version,
      a.status application_status,uj.in_table role_visible
      from users u join company_subscriptions s on s.user_id=u.id
      join companies c on c.id=s.company_id join jobs j on j.company_id=c.id
      join user_jobs uj on uj.job_id=j.id and uj.user_id=u.id
      join cv_libraries l on l.user_id=u.id join applications a on a.user_id=u.id and a.job_id=j.id
      where u.id=$1`, [ids.userId]);
    if (account?.email !== EMAIL || account.company !== COMPANY || account.role !== ROLE
      || account.library_version !== 1 || account.application_status !== 'applied' || !account.role_visible)
      throw new Error('Restored account-scoped company, role, Library or application content changed');
    web = await startWeb({ port: webPort, host: '127.0.0.1', logLimit: 0,
      env: { DATABASE_URL: target.href, SESSION_SECRET: secret, AVA_SERVERLESS_FALLBACK: '0', ANTHROPIC_API_KEY: '' } });
    const pages = [];
    for (const [path, marker] of [['/', ROLE], ['/companies', COMPANY], ['/applications', COMPANY], ['/library', 'Synthetic Candidate']]) {
      const response = await fetch(`http://127.0.0.1:${webPort}${path}`, { headers: { cookie: session.cookie },
        redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      const body = await response.text();
      pages.push({ path, status: response.status, markerFound: body.includes(marker) });
      if (response.status !== 200 || !body.includes(marker)) throw new Error(`Restored web ${path} failed account-content read`);
    }
    await targetPool.query('delete from sessions where id=$1', [sessionId]); sessionId = undefined;
    const revoked = await fetch(`http://127.0.0.1:${webPort}/api/work-status`, { headers: { cookie: session.cookie },
      redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    if (revoked.status !== 401 || !revoked.headers.get('cache-control')?.includes('no-store'))
      throw new Error('Restored web did not reject the revoked session privately');
    const { rows: unsafe } = await targetPool.query(`select type,status from tasks where type<>'reevaluate_gate'`);
    if (unsafe.length) throw new Error('Worker left unexpected external or paid work queued');
    report = { at: new Date().toISOString(), passed: true, elapsedSeconds: +((performance.now() - started) / 1000).toFixed(2),
      sourceDatabase: 'christopher_users_benchmark', targetDatabase: 'christopher_recovery_drill',
      syntheticOnly: true, provenance, logicalRestore: restored, actualWorkerHealthy: health.ok === true,
      workerHeartbeatRecorded: true, realGateTask: gate, accountContent: account, webPages: pages,
      revokedSession: { status: revoked.status, cacheControl: revoked.headers.get('cache-control') },
      workerStarted: true, webStarted: true, limitations: [
        'Local Docker PostgreSQL logical backup/restore and local web/worker processes only.',
        'No managed snapshot, production data, hosted deployment, RPO, RTO, rollback or external provider was exercised.',
        'Only a reversible gate task ran; source and restored databases remain for inspection.'
      ] };
  } catch (error) {
    failure = error;
    report = { at: new Date().toISOString(), passed: false, failure: String(error?.message ?? error).replaceAll(source.href, '[local source]').replaceAll(target.href, '[local target]'),
      sourceDatabase: 'christopher_users_benchmark', targetDatabase: 'christopher_recovery_drill',
      limitations: ['This failed local drill supplies no hosted recovery or deployment evidence.'] };
  } finally {
    if (sessionId) await targetPool.query('delete from sessions where id=$1', [sessionId]).catch(() => {});
    const cleanupErrors = [];
    await web?.stop({ graceMs: 1000 }).catch(error => cleanupErrors.push(`web stop: ${error.message}`));
    await worker?.stop().catch(error => cleanupErrors.push(`worker stop: ${error.message}`));
    const { rows: [sessionState] } = fixtureUserId
      ? await targetPool.query('select count(*)::int n from sessions where user_id=$1', [fixtureUserId]).catch(() => ({ rows: [{ n: null }] }))
      : { rows: [{ n: null }] };
    const cleanup = { sessionRemoved: sessionState.n === 0,
      webPortClosed: await portClosed(webPort, '/api/health'), workerPortClosed: await portClosed(workerPort, '/healthz'),
      errors: cleanupErrors };
    report ??= { at: new Date().toISOString(), passed: false, failure: 'Drill did not produce a result' };
    report.cleanup = cleanup;
    if (!cleanup.sessionRemoved && fixtureUserId || !cleanup.webPortClosed || !cleanup.workerPortClosed || cleanupErrors.length) report.passed = false;
    await Promise.all([admin.end(), sourcePool.end(), targetPool.end()]);
    await rm(work, { recursive: true, force: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ passed: report.passed, reportPath, elapsedSeconds: report.elapsedSeconds,
    pages: report.webPages, gate: report.realGateTask, cleanup: report.cleanup }));
  if (failure) throw failure;
  if (!report.passed) throw new Error('Restored pair cleanup failed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
