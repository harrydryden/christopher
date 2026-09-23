/** Bounded local capacity probe for 100 registered users and 10 active users. */
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import { cpus, freemem, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TARGETS = Object.freeze({ readP95Ms: 2_000, writeP95Ms: 4_000, maxErrors: 0, maxPhaseSeconds: 120 });
export function assertDedicatedDatabase(input, expected = 'christopher_users_benchmark') {
  const url = new URL(input);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '::1'].includes(url.hostname) ||
      database !== expected) throw new Error(`Use the dedicated local ${expected} database`);
  return url;
}
export function summarise(values) {
  const times = values.map(x => x.ms).sort((a, b) => a - b);
  const at = p => times.length ? Math.round(times[Math.min(times.length - 1, Math.floor(times.length * p))]) : null;
  return { requests: values.length, errors: values.filter(x => !x.ok).length, p50Ms: at(.5), p95Ms: at(.95), maxMs: times.length ? Math.round(times.at(-1)) : null };
}

async function main() {
  const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
  const { Pool } = require('pg');
  const url = assertDedicatedDatabase(process.env.DATABASE_URL ?? '');
  const pool = new Pool({ connectionString: url.href, max: 12, connectionTimeoutMillis: 5_000, statement_timeout: 30_000 });
  const port = Number(process.env.USERS_BENCHMARK_PORT ?? 3139);
  const soakSeconds = Number(process.env.USERS_SOAK_SECONDS ?? 60);
  const idleSeconds = Number(process.env.USERS_IDLE_SECONDS ?? 30);
  if (!Number.isSafeInteger(soakSeconds) || soakSeconds < 30 || soakSeconds > 300) throw new Error('USERS_SOAK_SECONDS must be 30..300');
  if (!Number.isSafeInteger(idleSeconds) || idleSeconds < 10 || idleSeconds > 120) throw new Error('USERS_IDLE_SECONDS must be 10..120');
  const secret = 'local-benchmark-only';
  let server, sampler;
  let serverLog = '', resourcePhase = 'startup';
  const phases = [], resources = [];
  const deadline = async (work, label) => {
    let timer;
    try {
      return await Promise.race([work, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${TARGETS.maxPhaseSeconds}s`)), TARGETS.maxPhaseSeconds * 1_000);
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    const { rows: [state] } = await pool.query(`select
      (select count(*)::int from companies) companies,
      (select count(*)::int from users where claimed_at is not null) claimed_users`);
    if (state.companies || state.claimed_users) throw new Error('Benchmark database must be empty apart from the unclaimed migration bootstrap account');
    await pool.query(`insert into users(email,name,claimed_at,email_verified_at)
      select 'load-'||n||'@benchmark.invalid','Load user '||n,now(),now() from generate_series(1,100) n`);
    await pool.query(`insert into companies(name,domain,homepage_url)
      select 'Load company '||n,'load-'||n||'.invalid','https://load-'||n||'.invalid' from generate_series(1,20) n`);
    await pool.query(`insert into career_sources(company_id,type,url,status)
      select id,case when row_number() over(order by id)%3=0 then 'html' else 'greenhouse' end,homepage_url||'/careers','active' from companies`);
    await pool.query(`insert into jobs(company_id,source_id,external_key,title,normalized_title,url,location,locations,description_text)
      select c.id,s.id,'load-'||n,'Engineer '||n,'engineer '||n,c.homepage_url||'/jobs/'||n,
      'London, UK','["London, UK"]'::jsonb,repeat('Engineering work with measurable customer outcomes. ',100)
      from companies c join career_sources s on s.company_id=c.id cross join generate_series(1,50) n`);
    await pool.query(`insert into company_subscriptions(user_id,company_id)
      select u.id,c.id from users u cross join companies c where u.email like '%@benchmark.invalid'`);
    await pool.query(`insert into user_jobs(user_id,job_id,in_table,keyword_matched,location_ok,fit_score,score_state)
      select u.id,j.id,true,true,true,55+(row_number() over(partition by u.id order by j.id)%40),'scored'
      from users u cross join jobs j where u.email like '%@benchmark.invalid'`);
    await pool.query(`insert into user_settings(user_id,key,value)
      select id,'seedProfile','"Engineering leadership in London"'::jsonb from users where email like '%@benchmark.invalid'`);
    await pool.query(`insert into cv_libraries(user_id,version,content)
      select id,1,jsonb_build_object('name',name,'contact',email,'profile',repeat('Engineering leader focused on reliable delivery. ',40),
      'entries',jsonb_build_array(jsonb_build_object('id','experience-1','kind','experience','heading','Engineering leadership — Load Company','company','Load Company','details',repeat('Led delivery and improved throughput by 25%.\\n',45))))
      from users where email like '%@benchmark.invalid'`);
    await pool.query(`insert into cv_drafts(user_id,job_id,job_title,company_name,job_description,library_version,library_snapshot,model,status,content)
      select u.id,j.id,j.title,c.name,j.description_text,1,l.content,'benchmark-fixture','ready',
      jsonb_build_object('name',u.name,'contact',u.email,'summary','Engineering leader focused on reliable delivery.',
        'sections',jsonb_build_array(jsonb_build_object('entryId','experience-1','kind','experience','heading','Engineering leadership — Load Company',
          'bullets',jsonb_build_array('Led delivery and improved throughput by 25%.'))),'gaps','[]'::jsonb)
      from users u join lateral (select * from jobs order by id limit 1) j on true
      join companies c on c.id=j.company_id join cv_libraries l on l.user_id=u.id and l.version=1
      where u.email like '%@benchmark.invalid'`);
    await pool.query(`insert into applications(user_id,cv_id,job_id,job_title,company_name,applied_on,status,notes,history)
      select d.user_id,d.id,d.job_id,d.job_title,d.company_name,current_date::text,'applied','Benchmark application',
      jsonb_build_array(jsonb_build_object('status','applied','at',now()::text,'notes','Benchmark application')) from cv_drafts d`);
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const { rows: sessions } = await pool.query(`insert into sessions(user_id,expires_at)
      select id,to_timestamp($1) from users where email like '%@benchmark.invalid' order by email returning id,user_id`, [expires]);
    const { rows: drafts } = await pool.query(`select id,user_id from cv_drafts where archived_at is null`);
    const draftByUser = new Map(drafts.map(row => [row.user_id, row.id]));
    await pool.query('analyze');
    const cookies = sessions.map(({ id }) => `ava_session=v2.${id}.${expires}.${createHmac('sha256', secret).update(`${id}.${expires}`).digest('base64url')}`);
    server = spawn(process.execPath, ['--inspect=127.0.0.1:0', require.resolve('next/dist/bin/next'), 'start', '-p', String(port)], {
      cwd: new URL('../apps/web', import.meta.url), detached: true,
      env: { ...process.env, SESSION_SECRET: secret, NODE_ENV: 'production', AVA_DISABLE_BROWSER: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', b => { serverLog = (serverLog + b).slice(-20_000); });
    server.stderr.on('data', b => { serverLog = (serverLog + b).slice(-20_000); });
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 500));
    }
    if (!ready) throw new Error(`Server did not start: ${serverLog}`);
    async function appHeapMiB() {
      const inspectorUrl = serverLog.match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1];
      if (!inspectorUrl) return null;
      return new Promise(resolveHeap => {
        const socket = new WebSocket(inspectorUrl);
        const timer = setTimeout(() => { socket.close(); resolveHeap(null); }, 1_000);
        socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.getHeapUsage' })));
        socket.addEventListener('message', event => {
          const message = JSON.parse(String(event.data));
          if (message.id !== 1) return;
          clearTimeout(timer); socket.close(); resolveHeap(Math.round(message.result.usedSize / 1048576));
        });
        socket.addEventListener('error', () => { clearTimeout(timer); resolveHeap(null); });
      });
    }
    sampler = setInterval(async () => {
      try {
        const { rows: [db] } = await pool.query(`select count(*)::int connections,count(*) filter(where state='active')::int active from pg_stat_activity where datname=current_database()`);
        const status = server?.pid ? await readFile(`/proc/${server.pid}/status`, 'utf8').catch(() => '') : '';
        let rssKiB = Number(status.match(/VmRSS:\s+(\d+)/)?.[1] ?? 0);
        if (!rssKiB && server?.pid) rssKiB = await new Promise(resolveRss =>
          execFile('ps', ['-o', 'rss=', '-p', String(server.pid)], (error, stdout) => resolveRss(error ? 0 : Number(stdout.trim()))));
        resources.push({ at: new Date().toISOString(), phase: resourcePhase, serverRssMiB: rssKiB ? Math.round(rssKiB / 1024) : null,
          serverHeapUsedMiB: await appHeapMiB(), benchmarkRssMiB: Math.round(process.memoryUsage().rss / 1048576),
          benchmarkHeapUsedMiB: Math.round(process.memoryUsage().heapUsed / 1048576), hostFreeMiB: Math.round(freemem() / 1048576), dbConnections: db.connections, dbActive: db.active });
      } catch {}
    }, 2_000);
    const paths = ['/?view=auto-matched', '/companies', '/applications', '/library', '/health', '/api/work-status'];
    const request = async (path, cookie) => {
      const start = performance.now();
      try {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { cookie }, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
        const body = await response.text();
        const visible = body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ');
        return { path, ms: performance.now() - start, status: response.status, ok: response.status === 200 && !/Application error|Internal Server Error/.test(visible) };
      } catch (error) { return { path, ms: performance.now() - start, status: 0, ok: false, error: String(error) }; }
    };
    for (const path of paths) { const warm = await request(path, cookies[0]); if (!warm.ok) throw new Error(`Warm-up failed: ${JSON.stringify(warm)}\n${serverLog}`); }
    async function reads(concurrency, total, label) {
      const results = []; let next = 0; const start = performance.now();
      await Promise.all(Array.from({ length: concurrency }, async () => {
        while (next < total) { const n = next++; results.push(await request(paths[n % paths.length], cookies[n % cookies.length])); }
      }));
      const seconds = (performance.now() - start) / 1000;
      phases.push({ label, concurrency, seconds: +seconds.toFixed(2), requestsPerSecond: +(results.length / seconds).toFixed(2),
        ...summarise(results), routes: Object.fromEntries(paths.map(p => [p, summarise(results.filter(x => x.path === p))])), failures: results.filter(x => !x.ok).slice(0, 10) });
    }
    resourcePhase = 'ten-active reads';
    await deadline(reads(10, 600, 'ten-active authenticated reads'), 'ten-active reads');
    const manageResults = [];
    async function manageCv(userId, cookie, action) {
      const start = performance.now();
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/cv/manage`, {
          method: 'POST', headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ids: [draftByUser.get(userId)], action, savedPage: 1, archivedPage: 1 }), signal: AbortSignal.timeout(10_000),
        });
        const body = await response.json();
        const stateOk = action === 'archive'
          ? body.pages?.saved?.total === 0 && body.pages?.archived?.total === 1
          : body.pages?.saved?.total === 1 && body.pages?.archived?.total === 0;
        return { action, ms: performance.now() - start, status: response.status, stateOk, ok: response.status === 200 && body.ok === true && stateOk };
      } catch (error) { return { action, ms: performance.now() - start, status: 0, ok: false, error: String(error) }; }
    }
    resourcePhase = 'authenticated CV writes';
    for (const action of ['archive', 'restore']) {
      manageResults.push(...await deadline(Promise.all(sessions.slice(0, 10).map((session, index) =>
        manageCv(session.user_id, cookies[index], action))), `CV ${action} writes`));
    }
    phases.push({ label: 'ten-active authenticated CV archive and restore', concurrency: 10,
      operations: { archives: 10, restores: 10 }, ...summarise(manageResults), failures: manageResults.filter(x => !x.ok) });
    resourcePhase = 'database fixture writes';
    const writes = [], activeUsers = sessions.slice(0, 10).map(x => x.user_id), writeStart = performance.now();
    await deadline(Promise.all(activeUsers.map(async (userId, userIndex) => {
      const client = await pool.connect(), started = performance.now();
      try {
        await client.query('begin');
        await client.query(`insert into decisions(user_id,job_id,decision,reason,tags,job_title,company_name,job_location,description_snippet,fit_score_at_decision)
          select $1,j.id,case when row_number() over(order by j.id)%2=0 then 'apply' else 'skip' end,'Benchmark decision','["benchmark"]'::jsonb,j.title,c.name,j.location,left(j.description_text,500),75
          from jobs j join companies c on c.id=j.company_id order by j.id limit 10`, [userId]);
        await client.query(`insert into cv_libraries(user_id,version,content) select user_id,2,
          jsonb_set(content,'{profile}',to_jsonb((content->>'profile')||' Saved during representative active-user workload.')) from cv_libraries where user_id=$1 and version=1`, [userId]);
        await client.query(`insert into tasks(type,payload,dedupe_key,priority) values
          ('review_library',jsonb_build_object('userId',$1::text,'libraryVersion',2),'benchmark-review-'||$1,3),
          ('rescore_all',jsonb_build_object('userId',$1::text),'benchmark-rescore-'||$1,4),
          ('scan_company',jsonb_build_object('companyId',(select id::text from companies order by id offset $2 limit 1),'userId',$1::text),'benchmark-scan-'||$1,2)`, [userId, userIndex]);
        await client.query('commit'); writes.push({ ok: true, ms: performance.now() - started });
      } catch (error) { await client.query('rollback'); writes.push({ ok: false, ms: performance.now() - started, error: String(error) }); } finally { client.release(); }
    })), 'representative writes');
    phases.push({ label: 'ten-active database decision, Library and queue fixtures', concurrency: 10, seconds: +((performance.now() - writeStart) / 1000).toFixed(2),
      operations: { decisions: 100, librarySaves: 10, queuedTasks: 30 }, ...summarise(writes), failures: writes.filter(x => !x.ok) });
    resourcePhase = 'ten-active soak';
    const soakResults = [], soakStart = performance.now();
    for (let elapsed = 0; elapsed < soakSeconds; elapsed += 10) {
      soakResults.push(...await Promise.all(sessions.slice(0, 10).map((_, index) => request(paths[(elapsed / 10 + index) % paths.length], cookies[index]))));
      if (elapsed + 10 < soakSeconds) await new Promise(r => setTimeout(r, 10_000));
    }
    phases.push({ label: `ten-active steady read soak (${soakSeconds}s)`, concurrency: 10, seconds: +((performance.now() - soakStart) / 1000).toFixed(2),
      requestsPerMinute: +(soakResults.length / soakSeconds * 60).toFixed(2), ...summarise(soakResults), failures: soakResults.filter(x => !x.ok).slice(0, 10) });
    resourcePhase = 'post-soak idle';
    await new Promise(r => setTimeout(r, idleSeconds * 1_000));
    resourcePhase = 'hundred-user burst';
    await deadline(reads(100, 600, 'hundred-user authenticated read burst'), 'hundred-user burst');
    resourcePhase = 'post-burst idle';
    await new Promise(r => setTimeout(r, idleSeconds * 1_000));
    const { rows: [counts] } = await pool.query(`select
      (select count(*)::int from users where email like '%@benchmark.invalid') users,(select count(*)::int from user_jobs) user_jobs,
      (select count(*)::int from cv_libraries) libraries,(select count(*)::int from cv_drafts) cvs,
      (select count(*)::int from applications) applications,(select count(*)::int from decisions) decisions,
      (select count(*)::int from tasks where dedupe_key like 'benchmark-%') queued_tasks`);
    const failures = [
      ...phases.filter(p => p.errors).map(p => `${p.label}: ${p.errors} errors`),
      ...phases.filter(p => /read|soak/.test(p.label) && p.p95Ms > TARGETS.readP95Ms).map(p => `${p.label}: p95 ${p.p95Ms}ms > ${TARGETS.readP95Ms}ms`),
      ...phases.filter(p => /authenticated CV/.test(p.label) && p.p95Ms > TARGETS.writeP95Ms).map(p => `${p.label}: p95 ${p.p95Ms}ms > ${TARGETS.writeP95Ms}ms`),
      ...(counts.users === 100 && counts.user_jobs === 100_000 && counts.libraries === 110 && counts.cvs === 100 && counts.applications === 100 && counts.decisions === 100 && counts.queued_tasks === 30 ? [] : [`fixture/count mismatch: ${JSON.stringify(counts)}`]),
    ];
    const report = { at: new Date().toISOString(), passed: failures.length === 0, failures,
      environment: { node: process.version, cpu: cpus()[0]?.model, cpuCount: cpus().length, hostMemoryMiB: Math.round(totalmem() / 1048576), database: url.pathname.slice(1) },
      target: { registeredUsers: 100, simultaneouslyActiveUsers: 10, soakSeconds, idleSeconds }, counts, thresholds: TARGETS, phases, resources,
      limitations: ['Local single Next.js process and local PostgreSQL; short warm workload with no think time.',
        'CV archive/restore crosses the authenticated HTTP boundary. Decision, Library and queue fixtures use production tables directly; their browser form handling, queue-start latency and completed worker/model work are not measured.',
        'The local inspector used for heap samples adds small diagnostic overhead and is bound to loopback.',
        'Synthetic populated CV/Library/application data is smaller than p95 documents. No imports, public shares, Chromium, external providers or paid models run.',
        'This does not establish hosted connection, memory, network, serverless fan-out or sustained-soak headroom.'] };
    await writeFile(process.env.USERS_REPORT_PATH ?? '/tmp/ava-users-report.json', JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed: report.passed, counts, phases: phases.map(({ label, errors, p95Ms, seconds }) => ({ label, errors, p95Ms, seconds })), failures }));
    if (!report.passed) process.exitCode = 1;
  } finally {
    if (sampler) clearInterval(sampler);
    if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch {} }
    await pool.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
