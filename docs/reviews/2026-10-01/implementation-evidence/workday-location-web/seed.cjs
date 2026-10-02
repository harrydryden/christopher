const {Client}=require('/Users/h_dryden/Documents/New project/christopher-jtbd-review/node_modules/.pnpm/pg@8.23.0/node_modules/pg');
const {createHmac}=require('node:crypto');const fs=require('node:fs');
const uri='postgres://postgres:postgres@127.0.0.1:55439/ava_locations_web';
(async()=>{const c=new Client({connectionString:uri});await c.connect();
await c.query('truncate companies, tasks, users, worker_events restart identity cascade');
await c.query("delete from settings where key='internal:workerHeartbeat'");
const u=(await c.query("insert into users(email,email_verified_at,name,role,claimed_at) values('location-browser@example.com',now(),'Browser fixture','member',now()) returning id")).rows[0];
const exp=Math.floor(Date.now()/1000)+86400;const session=(await c.query("insert into sessions(user_id,expires_at) values($1,to_timestamp($2)) returning id",[u.id,exp])).rows[0];
const secret='synthetic-location-browser-secret-2026';const sig=createHmac('sha256',secret).update(`${session.id}.${exp}`).digest('base64url');
fs.writeFileSync('/tmp/ava-locations-web-cookie',`v2.${session.id}.${exp}.${sig}`,{mode:0o600});
const co=(await c.query("insert into companies(name,homepage_url,domain,status) values('Workday fixture','https://fixture.test','fixture.test','active') returning id")).rows[0];
await c.query("insert into company_subscriptions(user_id,company_id,status) values($1,$2,'active')",[u.id,co.id]);
const so=(await c.query("insert into career_sources(company_id,type,url,status) values($1,'workday','https://fixture.wd1.myworkdayjobs.com/External','active') returning id",[co.id])).rows[0];
const rows=[];for(const [key,title,state,revision] of [['one','Senior analyst – queued locations','pending','rev-queued'],['two','Payroll consultant – locations unavailable','unavailable','rev-failed'],['three','Operations specialist – awaiting first check','pending',null]]){const j=(await c.query("insert into jobs(company_id,source_id,external_key,title,normalized_title,url,location_label,location_resolution,location_revision) values($1,$2,$3,$4,$5,$6,'2 Locations',$7,$8) returning id",[co.id,so.id,key,title,title.toLowerCase(),`https://fixture.wd1.myworkdayjobs.com/External/job/${key}`,state,revision])).rows[0];rows.push(j.id)}
const scheduled=process.argv[2]==='scheduled';
await c.query("insert into tasks(type,payload,dedupe_key,status,run_after) values('fetch_locations',$1,$2,'queued',now()+$3::interval)",[JSON.stringify({jobId:rows[0],locationRevision:'rev-queued'}),`fetch_locations:${rows[0]}:rev-queued`,scheduled?'1 hour':'0 seconds']);
if(scheduled)await c.query("insert into settings(key,value) values('internal:workerHeartbeat',$1::jsonb)",[JSON.stringify({at:new Date().toISOString(),workerId:'synthetic-browser-heartbeat',active:0,concurrency:1})]);
console.log(JSON.stringify({fixture:'synthetic offline',companyId:co.id,jobIds:rows,states:['pending queued','unavailable no task','pending null revision'],scheduled,syntheticHeartbeat:scheduled,cookiePath:'/tmp/ava-locations-web-cookie'}));await c.end()})().catch(e=>{console.error(e);process.exit(1)});
