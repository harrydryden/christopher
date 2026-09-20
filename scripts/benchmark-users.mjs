/**
 * Local authenticated HTTP benchmark. Run migrations and build first, then:
 * DATABASE_URL=postgres://...@127.0.0.1:55439/christopher_users_benchmark node scripts/benchmark-users.mjs
 * Only accepts a dedicated local, empty database. Retains fixtures for inspection; never truncates.
 */
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';

const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { Pool } = require('pg');
const url = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/christopher_users_benchmark') {
  throw new Error('Use the dedicated local christopher_users_benchmark database');
}
const pool = new Pool({ connectionString: url.href, max: 2 });
const port = 3139;
const secret = 'local-benchmark-only';
let server;
let serverLog = '';
const samples = [];
try {
  const { rows: [occupied] } = await pool.query("select (select count(*) from companies)::int + (select count(*) from users where email <> 'owner@christopher.invalid')::int as n");
  // The migrations may create an unclaimed bootstrap owner; no real accounts may be present.
  const { rows: [claimed] } = await pool.query('select count(*)::int as n from users where claimed_at is not null');
  const { rows: [companies] } = await pool.query('select count(*)::int as n from companies');
  if (claimed.n || companies.n || occupied.n > 0) throw new Error('Benchmark database must be empty apart from the migration bootstrap account');
  await pool.query(`insert into users(email,name,claimed_at,email_verified_at)
    select 'load-' || n || '@benchmark.invalid', 'Load user ' || n, now(), now() from generate_series(1,100) n`);
  await pool.query(`insert into companies(name,domain,homepage_url)
    select 'Load company ' || n, 'load-' || n || '.invalid', 'https://load-' || n || '.invalid' from generate_series(1,20) n`);
  await pool.query(`insert into career_sources(company_id,type,url,status)
    select id, 'greenhouse', homepage_url || '/careers', 'active' from companies`);
  await pool.query(`insert into jobs(company_id,source_id,external_key,title,normalized_title,url,location,locations,description_text)
    select c.id,s.id,'load-' || n,'Engineer ' || n,'engineer ' || n,c.homepage_url || '/jobs/' || n,
    'London, UK','["London, UK"]'::jsonb,repeat('Engineering work. ',100)
    from companies c join career_sources s on s.company_id=c.id cross join generate_series(1,50) n`);
  await pool.query(`insert into company_subscriptions(user_id,company_id)
    select u.id,c.id from users u cross join companies c where u.email like '%@benchmark.invalid'`);
  await pool.query(`insert into user_jobs(user_id,job_id,in_table,keyword_matched,location_ok,fit_score)
    select u.id,j.id,true,true,true,75 from users u cross join jobs j where u.email like '%@benchmark.invalid'`);
  await pool.query(`insert into user_settings(user_id,key,value)
    select id,'seedProfile','"Engineering in London"'::jsonb from users where email like '%@benchmark.invalid'`);
  const expires = Math.floor(Date.now()/1000) + 3600;
  const { rows: sessions } = await pool.query(`insert into sessions(user_id,expires_at)
    select id,to_timestamp($1) from users where email like '%@benchmark.invalid' returning id`, [expires]);
  await pool.query('analyze');
  const cookies = sessions.map(({id}) => `christopher_session=v2.${id}.${expires}.${createHmac('sha256',secret).update(`${id}.${expires}`).digest('base64url')}`);
  server = spawn(process.execPath, [require.resolve('next/dist/bin/next'),'start','-p',String(port)], {
    cwd: new URL('../apps/web',import.meta.url), detached:true,
    env: {...process.env, SESSION_SECRET:secret, NODE_ENV:'production', CHRISTOPHER_DISABLE_BROWSER:'1'},
    stdio:['ignore','pipe','pipe'],
  });
  server.stdout.on('data', b => {serverLog = (serverLog + b).slice(-20000);});
  server.stderr.on('data', b => {serverLog = (serverLog + b).slice(-20000);});
  let ready = false;
  for (let i=0;i<60;i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) {ready=true;break;} } catch {}
    await new Promise(r=>setTimeout(r,500));
  }
  if (!ready) throw new Error(`Server did not start: ${serverLog}`);
  const paths = ['/?view=auto-matched','/companies','/applications','/library','/health','/api/work-status'];
  async function request(path, cookie) {
    const start=performance.now();
    try {
      const response=await fetch(`http://127.0.0.1:${port}${path}`,{headers:{cookie},redirect:'manual',signal:AbortSignal.timeout(30000)});
      const body=await response.text();
      const visible=body.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<[^>]+>/g,' ');
      const ok=response.status===200 && !/Application error|Internal Server Error/.test(visible);
      return {path,ms:performance.now()-start,status:response.status,ok};
    } catch(error) {return {path,ms:performance.now()-start,status:0,ok:false,error:String(error)};}
  }
  // Warm every route before timed runs; these are not included in the sample counts.
  for (const path of paths) {
    const warm=await request(path,cookies[0]);
    if(!warm.ok) throw new Error(`Warm-up failed: ${JSON.stringify(warm)}\n${serverLog}`);
  }
  for (const concurrency of [10,100]) {
    const results=[];
    let next=0;
    const start=performance.now();
    await Promise.all(Array.from({length:concurrency},async()=>{
      while(next<600) {
        const n=next++;
        results.push(await request(paths[n%paths.length],cookies[n%cookies.length]));
      }
    }));
    const seconds=(performance.now()-start)/1000;
    const summary = values => {
      const times=values.map(x=>x.ms).sort((a,b)=>a-b);
      return {requests:values.length,errors:values.filter(x=>!x.ok).length,p50Ms:Math.round(times[Math.floor(times.length*.5)]),p95Ms:Math.round(times[Math.floor(times.length*.95)]),maxMs:Math.round(times.at(-1))};
    };
    samples.push({concurrency,seconds:Number(seconds.toFixed(2)),requestsPerSecond:Number((results.length/seconds).toFixed(2)),...summary(results),routes:Object.fromEntries(paths.map(p=>[p,summary(results.filter(x=>x.path===p))])),failures:results.filter(x=>!x.ok).slice(0,10)});
    console.log(JSON.stringify(samples.at(-1)));
  }
  const report={at:new Date().toISOString(),node:process.version,cpu:cpus()[0]?.model,users:100,companies:20,sharedJobs:1000,userJobRows:100000,samples,
    limitations:'Local single Next.js process and PostgreSQL 16 container; warm authenticated reads with no think time. Sessions are seeded, so login/password hashing, concurrent writes, AI, browser jobs, provider/network latency, serverless connection fan-out and sustained soak behaviour are not measured. This is a capacity probe, not production certification.'};
  await writeFile(process.env.USERS_REPORT_PATH ?? '/tmp/christopher-users-report.json',JSON.stringify(report,null,2)+'\n');
  if(samples.some(s=>s.errors)) process.exitCode=1;
} finally {
  if(server) {try {process.kill(-server.pid,'SIGTERM');} catch {}}
  await pool.end();
}
