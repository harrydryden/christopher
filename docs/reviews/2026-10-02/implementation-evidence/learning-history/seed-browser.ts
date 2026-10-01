/** Isolated synthetic Learning history fixture; never genuine calibration evidence. */
import { createDb } from '../../../../../packages/db/src/client';
import { runMigrations } from '../../../../../packages/db/src/migrate';
import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
async function main() {
 const name='ava_learning_history_ui_1002';
 const admin=createDb('postgres://postgres:postgres@127.0.0.1:55439/postgres');
 try { if (!(await admin.pool.query('select 1 from pg_database where datname=$1',[name])).rows.length) await admin.pool.query(`create database ${name}`); }
 finally { await admin.pool.end(); }
 const {db,pool}=createDb(`postgres://postgres:postgres@127.0.0.1:55439/${name}`);
 try {
  await runMigrations(db);
  const user=(await pool.query(`insert into users(email,name,role,claimed_at,email_verified_at) values('history@example.test','Synthetic history member','member',now(),now()) on conflict(email) do update set name=excluded.name returning id`)).rows[0];
  const foreign=(await pool.query(`insert into users(email,name,role,claimed_at,email_verified_at) values('foreign-history@example.test','Other synthetic member','member',now(),now()) on conflict(email) do update set name=excluded.name returning id`)).rows[0];
  const expires=Math.floor(Date.now()/1000)+86400;
  const session=(await pool.query('insert into sessions(user_id,expires_at) values($1,to_timestamp($2)) returning id',[user.id,expires])).rows[0];
  const signature=createHmac('sha256','synthetic-learning-history-browser-secret-2026').update(`${session.id}.${expires}`).digest('base64url');
  writeFileSync('/tmp/ava-learning-history-cookie',`v2.${session.id}.${expires}.${signature}`,{mode:0o600});
  await pool.query(`insert into user_settings(user_id,key,value) values($1,'seedProfile','"Operations leadership in London."'::jsonb) on conflict(user_id,key) do nothing`,[user.id]);
  for (const version of [1,3]) await pool.query(`insert into preference_profiles(user_id,version,markdown,pinned_statements,open_questions,source_decision_count,model) values($1,$2,$3,$4,$5,26,'synthetic-fixture') on conflict(user_id,version) do nothing`,[user.id,version,version===1?'# Preferences\nLondon office roles.\nSupportive team.':'# Preferences\nHybrid London roles.\nSupportive team.',JSON.stringify(version===1?['No relocation.']:['No relocation.','Clear ownership.']),JSON.stringify([{id:'q1',question:'What does supportive mean?',...(version===3?{answer:'Regular feedback.'}:{})}])]);
  await pool.query(`insert into preference_profiles(user_id,version,markdown) values($1,2,'FOREIGN PROFILE MUST NEVER APPEAR') on conflict(user_id,version) do nothing`,[foreign.id]);
  for (const id of [user.id,foreign.id]) await pool.query(`insert into tag_vocabulary(user_id,tag,accepted) values($1,'remote',true),($1,'leadership',true),($1,'culture',true) on conflict(user_id,tag) do nothing`,[id]);
  const decisions=[];
  for(let n=1;n<=26;n++) {
   const title=`History role ${String(n).padStart(2,'0')}`;
   let row=(await pool.query('select id from decisions where user_id=$1 and job_title=$2',[user.id,title])).rows[0];
   if(!row) row=(await pool.query(`insert into decisions(user_id,decision,reason,tags,tags_edited,job_title,company_name,created_at) values($1,'apply','Clear ownership.','["leadership"]',false,$2,'Synthetic History',now()-($3*interval '1 minute')) returning id`,[user.id,title,n])).rows[0];
   decisions.push({number:n,id:row.id});
  }
  await pool.query(`insert into decisions(user_id,decision,job_title,company_name) select $1,'skip','FOREIGN DECISION MUST NEVER APPEAR','Foreign Synthetic' where not exists(select 1 from decisions where user_id=$1)`,[foreign.id]);
  console.log(JSON.stringify({database:name,userId:user.id,foreignId:foreign.id,decisions,synthetic:true}));
 } finally { await pool.end(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
