/** Synthetic local UI fixture. Creates only the dedicated confirmation browser database. */
import { createDb } from '../../../../../packages/db/src/client';
import { runMigrations } from '../../../../../packages/db/src/migrate';
import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';

async function main() {
  const name = 'ava_confirmation_ui_1001';
  const admin = createDb('postgres://postgres:postgres@127.0.0.1:55439/postgres');
  try {
    if (!(await admin.pool.query('select 1 from pg_database where datname=$1', [name])).rows.length)
      await admin.pool.query(`create database ${name}`);
  } finally { await admin.pool.end(); }
  const { db, pool } = createDb(`postgres://postgres:postgres@127.0.0.1:55439/${name}`);
  try {
    await runMigrations(db);
    const user = (await pool.query(`insert into users(email,name,role,claimed_at) values
      ('confirmation-ui@example.test','Confirmation fixture','member',now())
      on conflict(email) do update set name=excluded.name returning id`)).rows[0];
    const expires = Math.floor(Date.now()/1000)+86400;
    const session = (await pool.query('insert into sessions(user_id,expires_at) values($1,to_timestamp($2)) returning id',[user.id,expires])).rows[0];
    const signature=createHmac('sha256','synthetic-confirmation-browser-secret-2026').update(`${session.id}.${expires}`).digest('base64url');
    writeFileSync('/tmp/ava-confirmation-ui-cookie',`v2.${session.id}.${expires}.${signature}`,{mode:0o600});
    await pool.query(`insert into user_settings(user_id,key,value) values($1,'seedProfile',$2::jsonb)
      on conflict(user_id,key) do update set value=excluded.value`,[user.id,JSON.stringify('I want operations roles in London with clear ownership.')]);
    console.log(JSON.stringify({database:name,userId:user.id,cookiePath:'/tmp/ava-confirmation-ui-cookie',synthetic:true}));
  } finally { await pool.end(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
