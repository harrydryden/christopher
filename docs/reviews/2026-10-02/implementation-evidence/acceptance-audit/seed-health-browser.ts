/** Synthetic local Health permission fixtures. No worker or provider is needed. */
import { createDb } from '../../../../../packages/db/src/client';
import { runMigrations } from '../../../../../packages/db/src/migrate';
import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';

async function main() {
  const name = 'ava_health_permissions_ui_1002';
  const admin = createDb('postgres://postgres:postgres@127.0.0.1:55439/postgres');
  try {
    if (!(await admin.pool.query('select 1 from pg_database where datname=$1', [name])).rows.length)
      await admin.pool.query(`create database ${name}`);
  } finally { await admin.pool.end(); }
  const { db, pool } = createDb(`postgres://postgres:postgres@127.0.0.1:55439/${name}`);
  try {
    await runMigrations(db);
    const users: Record<string,string> = {};
    for (const role of ['member', 'admin']) {
      const user = (await pool.query(`insert into users(email,name,role,claimed_at,email_verified_at)
        values($1,$2,$3,now(),now()) on conflict(email) do update set email_verified_at=now() returning id`,
        [`health-${role}@example.test`, `Synthetic Health ${role}`, role])).rows[0];
      users[role] = user.id;
      const expires = Math.floor(Date.now()/1000)+86400;
      const session = (await pool.query('insert into sessions(user_id,expires_at) values($1,to_timestamp($2)) returning id',[user.id,expires])).rows[0];
      const signature=createHmac('sha256','synthetic-health-browser-secret-2026').update(`${session.id}.${expires}`).digest('base64url');
      writeFileSync(`/tmp/ava-health-${role}-cookie`,`v2.${session.id}.${expires}.${signature}`,{mode:0o600});
    }
    const scenarios = [
      { name:'Failing shared source', slug:'failing', status:'failing', proposal:false },
      { name:'Initial confirmation', slug:'initial', status:null, proposal:true },
      { name:'Replacement proposal', slug:'replacement', status:'active', proposal:true },
      { name:'Blocked reactivation', slug:'blocked', status:'blocked', proposal:true },
      { name:'Confirmation race', slug:'race', status:null, proposal:true },
    ];
    const companies: Record<string,string> = {};
    for (const item of scenarios) {
      const company = (await pool.query(`insert into companies(name,homepage_url,domain) values($1,$2,$3)
        on conflict(domain) do update set name=excluded.name returning id`,
        [item.name,`https://${item.slug}.example.test`,`${item.slug}.example.test`])).rows[0];
      companies[item.slug] = company.id;
      for (const userId of Object.values(users)) await pool.query(`insert into company_subscriptions(user_id,company_id)
        values($1,$2) on conflict(user_id,company_id) do nothing`,[userId,company.id]);
      const sourceSlug=`synthetic-health-${item.slug}`;
      if (item.status) await pool.query(`insert into career_sources(company_id,type,url,ats_slug,status,confirmed_by_user,consecutive_failures)
        select $1,'greenhouse',$2,$3,$4,true,3 where not exists(select 1 from career_sources where company_id=$1)`,
        [company.id,`https://boards.greenhouse.io/${sourceSlug}`,sourceSlug,item.status]);
      if (item.proposal) {
        const candidateSlug=item.slug==='replacement' ? `${sourceSlug}-new` : sourceSlug;
        await pool.query(`insert into discovery_runs(company_id,status,candidates,finished_at)
          select $1,'needs_confirmation',$2::jsonb,now() where not exists(select 1 from discovery_runs where company_id=$1)`,
          [company.id,JSON.stringify([{spec:{type:'greenhouse',url:`https://boards.greenhouse.io/${candidateSlug}`,atsSlug:candidateSlug},confidence:0.9,method:'synthetic-fixture'}])]);
      }
    }
    console.log(JSON.stringify({database:name,users,companies,synthetic:true}));
  } finally { await pool.end(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
