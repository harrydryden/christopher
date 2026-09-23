/**
 * Reproducible local logical backup/restore drill. It refuses remote hosts, any source other than
 * christopher_users_benchmark, and any existing target. It never drops a database and leaves the
 * isolated restore available for smoke testing and inspection.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateRecoveryUrls(sourceInput, targetInput) {
  const source = new URL(sourceInput), target = new URL(targetInput);
  const local = u => ['127.0.0.1', 'localhost', '::1'].includes(u.hostname);
  if (!['postgres:', 'postgresql:'].includes(source.protocol) || !['postgres:', 'postgresql:'].includes(target.protocol) || !local(source) || !local(target))
    throw new Error('Recovery drill requires local PostgreSQL source and target URLs');
  if (decodeURIComponent(source.pathname.slice(1)) !== 'christopher_users_benchmark')
    throw new Error('Recovery source must be christopher_users_benchmark');
  if (decodeURIComponent(target.pathname.slice(1)) !== 'christopher_recovery_drill')
    throw new Error('Recovery target must be christopher_recovery_drill');
  if (source.hostname !== target.hostname || source.port !== target.port || source.username !== target.username)
    throw new Error('Recovery source and target must use the same local PostgreSQL server and user');
  return { source, target };
}
/**
 * One reading of what a restore must bring back intact: row counts for every table an account's
 * work lives in, order-independent fingerprints over the rows whose content matters (an account's
 * roles, decisions and settings, and the catalogue's sources), and orphan counts for the
 * relationships a partial restore would break. Compared before and after, a restore that lost the
 * learning signal or everyone's gate settings fails even when the headline counts survive.
 */
export function coreIntegritySql() {
  return `select jsonb_build_object(
    'users',(select count(*) from users),'companies',(select count(*) from companies),
    'jobs',(select count(*) from jobs),'user_jobs',(select count(*) from user_jobs),
    'libraries',(select count(*) from cv_libraries),'cvs',(select count(*) from cv_drafts),
    'applications',(select count(*) from applications),'tasks',(select count(*) from tasks),
    'decisions',(select count(*) from decisions),'userSettings',(select count(*) from user_settings),
    'systemSettings',(select count(*) from settings),'preferenceProfiles',(select count(*) from preference_profiles),
    'companyProfiles',(select count(*) from company_profiles),'subscriptions',(select count(*) from company_subscriptions),
    'sources',(select count(*) from career_sources),'scans',(select count(*) from scans),
    'authAccounts',(select count(*) from auth_accounts),'cvBuildSteps',(select count(*) from cv_build_steps),
    'userJobFingerprint',(select coalesce(sum(hashtextextended(user_id::text||':'||job_id::text,0)),0)::text from user_jobs),
    'decisionFingerprint',(select coalesce(sum(hashtextextended(user_id::text||':'||coalesce(job_id::text,'-')||':'||decision||':'||superseded::text,0)),0)::text from decisions),
    'userSettingsFingerprint',(select coalesce(sum(hashtextextended(user_id::text||':'||key||':'||value::text,0)),0)::text from user_settings),
    'sourceFingerprint',(select coalesce(sum(hashtextextended(company_id::text||':'||url||':'||status,0)),0)::text from career_sources),
    'orphans',jsonb_build_object(
      'userJobs',(select count(*) from user_jobs uj left join users u on u.id=uj.user_id left join jobs j on j.id=uj.job_id where u.id is null or j.id is null),
      'libraries',(select count(*) from cv_libraries l left join users u on u.id=l.user_id where u.id is null),
      'applications',(select count(*) from applications a left join users u on u.id=a.user_id where u.id is null),
      'subscriptions',(select count(*) from company_subscriptions s left join users u on u.id=s.user_id left join companies c on c.id=s.company_id where u.id is null or c.id is null),
      'decisions',(select count(*) from decisions d left join users u on u.id=d.user_id where u.id is null),
      'userSettings',(select count(*) from user_settings us left join users u on u.id=us.user_id where u.id is null),
      'sources',(select count(*) from career_sources cs left join companies c on c.id=cs.company_id where c.id is null),
      'scans',(select count(*) from scans sc left join career_sources cs on cs.id=sc.source_id where cs.id is null)
    ),
    'invalidConstraints',(select count(*) from pg_constraint where not convalidated),
    'migrationCount',(select count(*) from drizzle.__drizzle_migrations)
  ) result`;
}

async function main() {
  const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
  const { Client } = require('pg');
  const { source, target } = validateRecoveryUrls(
    process.env.RECOVERY_SOURCE_URL ?? process.env.DATABASE_URL ?? '',
    process.env.RECOVERY_TARGET_URL ?? '',
  );
  const timeoutMs = Number(process.env.RECOVERY_TIMEOUT_MS ?? 180_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 900_000) throw new Error('RECOVERY_TIMEOUT_MS must be 10000..900000');
  const sourceDb = decodeURIComponent(source.pathname.slice(1)), targetDb = decodeURIComponent(target.pathname.slice(1));
  const sourceClient = new Client({ connectionString: source.href, connectionTimeoutMillis: 5_000, statement_timeout: 30_000 });
  let before, sourceVersion;
  await sourceClient.connect();
  try {
    const { rows: [exists] } = await sourceClient.query('select exists(select 1 from pg_database where datname=$1) present', [targetDb]);
    if (exists.present) throw new Error(`Target database ${targetDb} already exists; inspect, rename or remove it yourself before running the drill`);
    ({ rows: [{ result: before }] } = await sourceClient.query(coreIntegritySql()));
    ({ rows: [sourceVersion] } = await sourceClient.query('select current_setting(\'server_version\') server_version, current_setting(\'server_version_num\')::int server_version_num'));
  } finally { await sourceClient.end(); }
  if (Object.values(before.orphans).some(Number) || Number(before.invalidConstraints)) throw new Error(`Source integrity check failed: ${JSON.stringify(before)}`);
  const work = await mkdtemp(join(tmpdir(), 'ava-recovery-'));
  const dump = join(work, 'backup.dump');
  const dockerContainer = process.env.RECOVERY_DOCKER_CONTAINER;
  const containerDump = `/tmp/ava-recovery-${process.pid}.dump`;
  const commands = [];
  const run = (command, args, env = process.env) => new Promise((resolve, reject) => {
    const started = performance.now(), child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${command} timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', b => { stdout = (stdout + b).slice(-20_000); });
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-20_000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      const operation = ['pg_dump', 'createdb', 'pg_restore', 'cp', 'rm'].find(item => args.includes(item)) ?? command;
      clearTimeout(timer); commands.push({ command: command === 'docker' ? `docker ${operation}` : operation, seconds: +((performance.now() - started) / 1000).toFixed(2), code });
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
  const started = performance.now();
  try {
    let dumpVersion;
    if (dockerContainer) {
      const dockerPrefix = ['exec', '-e', 'PGPASSWORD', dockerContainer];
      const dockerEnv = { ...process.env, PGPASSWORD: decodeURIComponent(source.password) };
      dumpVersion = (await run('docker', [...dockerPrefix, 'pg_dump', '--version'], dockerEnv)).stdout.trim();
      await run('docker', [...dockerPrefix, 'pg_dump', '--format=custom', '--no-owner', '--no-privileges', '--file', containerDump, '-U', decodeURIComponent(source.username), sourceDb], dockerEnv);
      await run('docker', ['cp', `${dockerContainer}:${containerDump}`, dump]);
      await run('docker', [...dockerPrefix, 'createdb', '-U', decodeURIComponent(source.username), targetDb], dockerEnv);
      await run('docker', [...dockerPrefix, 'pg_restore', '--exit-on-error', '--no-owner', '--no-privileges', '--dbname', targetDb, '-U', decodeURIComponent(source.username), containerDump], dockerEnv);
    } else {
      dumpVersion = (await run('pg_dump', ['--version'])).stdout.trim();
      await run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', dump, source.href]);
      const admin = new URL(source); admin.pathname = '/postgres';
      await run('createdb', ['--maintenance-db', admin.href, targetDb]);
      await run('pg_restore', ['--exit-on-error', '--no-owner', '--no-privileges', '--dbname', target.href, dump]);
    }
    // Current migrations must be idempotent on the restored schema. This also proves the restored
    // migration ledger is understood by the checked-out release.
    await run('pnpm', ['db:migrate'], { ...process.env, DATABASE_URL: target.href });
    const restored = new Client({ connectionString: target.href, connectionTimeoutMillis: 5_000, statement_timeout: 30_000 });
    await restored.connect();
    const { rows: [{ result: after }] } = await restored.query(coreIntegritySql());
    const { rows: [targetVersion] } = await restored.query('select current_setting(\'server_version\') server_version, current_setting(\'server_version_num\')::int server_version_num');
    await restored.end();
    const failures = [];
    if (JSON.stringify(before) !== JSON.stringify(after)) failures.push('source and restored counts/fingerprint/integrity differ');
    if (Object.values(after.orphans).some(Number)) failures.push(`restored orphan rows: ${JSON.stringify(after.orphans)}`);
    if (Number(after.invalidConstraints)) failures.push(`${after.invalidConstraints} restored constraints are not validated`);
    if (sourceVersion.server_version_num !== targetVersion.server_version_num) failures.push('source and target server versions differ');
    const report = { at: new Date().toISOString(), passed: failures.length === 0, failures,
      elapsedSeconds: +((performance.now() - started) / 1000).toFixed(2), sourceDatabase: sourceDb, targetDatabase: targetDb,
      sourceVersion, targetVersion, pgDumpVersion: dumpVersion, before, after, commands,
      compatibility: { currentMigrationsReran: commands.some(x => x.command === 'pnpm' && x.code === 0), sourceAndTargetServerMatch: sourceVersion.server_version_num === targetVersion.server_version_num },
      limitations: ['This is a local logical dump, not a managed snapshot or point-in-time restore.', 'It does not establish production backup scheduling, retention, encryption, access control, RPO or hosted RTO.', 'Rollback to an older application revision is not automated; destructive down-migrations are deliberately excluded.'] };
    await writeFile(process.env.RECOVERY_REPORT_PATH ?? '/tmp/ava-recovery-report.json', JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed: report.passed, elapsedSeconds: report.elapsedSeconds, targetDatabase: targetDb, before, after, failures }));
    if (!report.passed) process.exitCode = 1;
  } finally {
    if (dockerContainer) await run('docker', ['exec', dockerContainer, 'rm', '-f', containerDump]).catch(() => {});
    await rm(work, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
