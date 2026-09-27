/**
 * The audits' fixture: the capacity probe's hundred-account shape (100 accounts, 20 companies each
 * followed by everyone, 50 roles per company, a Library, a CV and an application per account), plus
 * what load user 1 needs for every page to have something to show: 40 decisions, role events, a
 * finished scan run and two weeks of scans. The same rows docs/performance/A-baseline.md measured.
 *
 *   createdb ava_perf_ci
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/ava_perf_ci pnpm db:migrate
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/ava_perf_ci node scripts/perf/fixture.mjs [out.json]
 *
 * Refuses any database that is not a local ava_perf* scratch database, and one that already has
 * companies or claimed accounts. Writes the ids and forged session cookies to `out.json`
 * (default perf-out/fixture.json), which the other measurements read.
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { benchmarkShape } from "../benchmark-users.mjs";
import { assertPerfDatabase, BENCH_SECRET, sessionCookie } from "./lib.mjs";

export async function seedFixture(pool, shape = benchmarkShape({}), secret = BENCH_SECRET) {
  const q = (text, params) => pool.query(text, params);
  const { rows: [state] } = await q(`select (select count(*)::int from companies) companies, (select count(*)::int from users where claimed_at is not null) claimed`);
  if (state.companies || state.claimed) throw new Error("The perf database must be empty apart from the unclaimed migration bootstrap account; drop and recreate it.");
  await q(`insert into users(email,name,claimed_at,email_verified_at)
    select 'load-'||n||'@benchmark.invalid','Load user '||n,now(),now() from generate_series(1,$1::int) n`, [shape.accounts]);
  await q(`insert into companies(name,domain,homepage_url)
    select 'Load company '||n,'load-'||n||'.invalid','https://load-'||n||'.invalid' from generate_series(1,$1::int) n`, [shape.companies]);
  await q(`insert into career_sources(company_id,type,url,status)
    select id,case when row_number() over(order by id)%3=0 then 'html' else 'greenhouse' end,homepage_url||'/careers','active' from companies`);
  await q(`insert into jobs(company_id,source_id,external_key,title,normalized_title,url,location,locations,description_text)
    select c.id,s.id,'load-'||n,'Engineer '||n,'engineer '||n,c.homepage_url||'/jobs/'||n,
    'London, UK','["London, UK"]'::jsonb,repeat('Engineering work with measurable customer outcomes. ',100)
    from companies c join career_sources s on s.company_id=c.id cross join generate_series(1,$1::int) n`, [shape.jobsPerCompany]);
  await q(`insert into company_subscriptions(user_id,company_id)
    select u.id,c.id from (select id,row_number() over(order by email)-1 n from users where email like '%@benchmark.invalid') u
    join (select id,row_number() over(order by id)-1 n from companies) c on ((c.n-u.n*$1::int)%$2::int+$2::int)%$2::int<$1::int`, [shape.follows, shape.companies]);
  await q(`insert into user_jobs(user_id,job_id,in_table,keyword_matched,location_ok,fit_score,score_state)
    select s.user_id,j.id,true,true,true,55+(row_number() over(partition by s.user_id order by j.id)%40),'scored'
    from company_subscriptions s join jobs j on j.company_id=s.company_id`);
  await q(`insert into user_settings(user_id,key,value)
    select id,'seedProfile','"Engineering leadership in London"'::jsonb from users where email like '%@benchmark.invalid'`);
  await q(`insert into cv_libraries(user_id,version,content)
    select id,1,jsonb_build_object('name',name,'contact',email,'profile',repeat('Engineering leader focused on reliable delivery. ',40),
    'entries',jsonb_build_array(jsonb_build_object('id','experience-1','kind','experience','heading','Engineering leadership — Load Company','company','Load Company','details',repeat('Led delivery and improved throughput by 25%.\\n',45))))
    from users where email like '%@benchmark.invalid'`);
  await q(`insert into cv_drafts(user_id,job_id,job_title,company_name,job_description,library_version,library_snapshot,model,status,content)
    select u.id,j.id,j.title,c.name,j.description_text,1,l.content,'benchmark-fixture','ready',
    jsonb_build_object('name',u.name,'contact',u.email,'summary','Engineering leader focused on reliable delivery.',
      'sections',jsonb_build_array(jsonb_build_object('entryId','experience-1','kind','experience','heading','Engineering leadership — Load Company',
        'bullets',jsonb_build_array('Led delivery and improved throughput by 25%.'))),'gaps','[]'::jsonb)
    from users u join lateral (select j.* from jobs j join company_subscriptions s on s.company_id=j.company_id and s.user_id=u.id order by j.id limit 1) j on true
    join companies c on c.id=j.company_id join cv_libraries l on l.user_id=u.id and l.version=1
    where u.email like '%@benchmark.invalid'`);
  await q(`insert into applications(user_id,cv_id,job_id,job_title,company_name,applied_on,status,notes,history)
    select d.user_id,d.id,d.job_id,d.job_title,d.company_name,current_date::text,'applied','Benchmark application',
    jsonb_build_array(jsonb_build_object('status','applied','at',now()::text,'notes','Benchmark application')) from cv_drafts d`);
  const { rows: [u1] } = await q(`select id from users where email='load-1@benchmark.invalid'`);
  await q(`insert into decisions(user_id,job_id,decision,reason,tags,job_title,company_name,job_location,description_snippet,fit_score_at_decision,created_at)
    select $1,j.id,case when rn%2=0 then 'apply' else 'skip' end,'Benchmark decision','["benchmark"]'::jsonb,j.title,c.name,j.location,left(j.description_text,500),75, now()-rn*interval '1 hour'
    from (select j.*, row_number() over(order by j.id) rn from jobs j) j join companies c on c.id=j.company_id where rn<=40`, [u1.id]);
  await q(`insert into job_events(job_id,type,payload,at) select id,'new','{}'::jsonb,now()-interval '3 days' from jobs`);
  await q(`insert into job_events(job_id,type,payload,at,user_id) select job_id,'scored','{"score":70}'::jsonb,now()-interval '2 days',user_id from user_jobs where user_id=$1`, [u1.id]);
  const { rows: [run] } = await q(`insert into scan_runs(run_date,trigger,companies_total,companies_ok,finished_at,started_at)
    select to_char(now()-interval '1 day','YYYY-MM-DD'),'schedule',count(*)::int,count(*)::int,now()-interval '23 hours',now()-interval '1 day' from companies returning id`);
  await q(`insert into scans(scan_run_id,source_id,started_at,finished_at,status,fetch_method,postings_found,duration_ms)
    select $1,id,now()-interval '1 day',now()-interval '1 day'+interval '5 seconds','ok','api',50,5000 from career_sources`, [run.id]);
  await q(`insert into scans(source_id,started_at,finished_at,status,fetch_method,postings_found,duration_ms)
    select id,now()-g*interval '1 day',now()-g*interval '1 day'+interval '5 seconds','ok','api',50,5000 from career_sources cross join generate_series(2,14) g`);
  // A week of sessions, so a weekly run can re-measure a fixture seeded a few days before.
  const expires = Math.floor(Date.now() / 1000) + 7 * 86_400;
  const { rows: sessions } = await q(`insert into sessions(user_id,expires_at)
    select id,to_timestamp($1) from users where email like '%@benchmark.invalid' order by email returning id,user_id`, [expires]);
  const { rows: [draft] } = await q(`select id from cv_drafts where user_id=$1`, [u1.id]);
  const { rows: [company] } = await q(`select id from companies order by name limit 1`);
  await q("analyze");
  const cookie = session => sessionCookie(secret, session.id, expires);
  const s1 = sessions.find(s => s.user_id === u1.id);
  return { user1: u1.id, cookie1: cookie(s1), draft1: draft.id, company1: company.id, cookies: sessions.map(s => ({ user: s.user_id, cookie: cookie(s) })) };
}

async function main() {
  const url = assertPerfDatabase(process.env.DATABASE_URL ?? "");
  const out = resolve(process.argv[2] ?? "perf-out/fixture.json");
  const { Pool } = createRequire(new URL("../../apps/web/package.json", import.meta.url))("pg");
  const pool = new Pool({ connectionString: url.href, max: 2 });
  try {
    const fixture = await seedFixture(pool);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(fixture, null, 1));
    console.log(`fixture written to ${out}`);
  } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
