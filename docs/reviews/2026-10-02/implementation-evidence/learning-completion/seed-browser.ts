/** Synthetic local UI fixture. Creates only the dedicated learning-recovery browser database. */
import { createDb } from '../../../../../packages/db/src/client';
import { runMigrations } from '../../../../../packages/db/src/migrate';
import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';

async function main() {
  const name = 'ava_learning_completion_ui_1002';
  const admin = createDb('postgres://postgres:postgres@127.0.0.1:55439/postgres');
  try {
    if (!(await admin.pool.query('select 1 from pg_database where datname=$1', [name])).rows.length)
      await admin.pool.query(`create database ${name}`);
  } finally { await admin.pool.end(); }
  const { db, pool } = createDb(`postgres://postgres:postgres@127.0.0.1:55439/${name}`);
  try {
    await runMigrations(db);
    const user = (await pool.query(`insert into users(email,name,role,claimed_at) values
      ('learning-completion-ui@example.test','Learning completion fixture','member',now())
      on conflict(email) do update set name=excluded.name returning id`)).rows[0];
    const expires = Math.floor(Date.now()/1000)+86400;
    const session = (await pool.query('insert into sessions(user_id,expires_at) values($1,to_timestamp($2)) returning id',[user.id,expires])).rows[0];
    const signature=createHmac('sha256','synthetic-learning-completion-browser-secret-2026').update(`${session.id}.${expires}`).digest('base64url');
    writeFileSync('/tmp/ava-learning-completion-ui-cookie',`v2.${session.id}.${expires}.${signature}`,{mode:0o600});
    await pool.query(`insert into user_settings(user_id,key,value) values($1,'seedProfile',$2::jsonb)
      on conflict(user_id,key) do update set value=excluded.value`,[user.id,JSON.stringify('I want operations roles in London with clear ownership.')]);
    await pool.query('update users set email_verified_at=now() where id=$1',[user.id]);
    await pool.query(`insert into preference_profiles(user_id,version,markdown,pinned_statements,open_questions,source_decision_count,model)
      values($1,1,'Operations leadership with a supportive team.','["No relocation."]'::jsonb,
        '[{"id":"q1","question":"What does a supportive team mean to you?"}]'::jsonb,4,'synthetic-fixture')
      on conflict(user_id,version) do nothing`,[user.id]);
    await pool.query(`insert into tag_vocabulary(user_id,tag,accepted) values($1,'remote',true),($1,'leadership',true),($1,'culture',true)
      on conflict(user_id,tag) do nothing`,[user.id]);
    await pool.query(`insert into decisions(id,user_id,decision,reason,tags,tags_edited,job_title,company_name)
      values('d40fc457-4bda-4e48-9842-602fd43c4584',$1,'apply','Supportive team and clear ownership.','["leadership"]',false,'Operations Lead','Synthetic Example')
      on conflict(id) do nothing`,[user.id]);
    console.log(JSON.stringify({database:name,userId:user.id,cookiePath:'/tmp/ava-learning-completion-ui-cookie',synthetic:true}));
  } finally { await pool.end(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
