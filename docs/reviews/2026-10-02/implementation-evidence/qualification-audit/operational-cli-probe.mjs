/** Exercise the actual read-only CLI against an isolated synthetic HTTP endpoint. */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const commit='a'.repeat(40);
let ratio=0.846;
const server=createServer((req,res)=>{
 res.setHeader('content-type','application/json');
 res.end(JSON.stringify({ok:true,commit,workerId:'synthetic-worker',privatePayload:'PRIVATE_BODY_MARKER',metrics:{ready:0,running:0,oldest_seconds:0,overdueCompanies:0,overdueDiscovery:0,crashRecoveries1h:0,crashRecoveries24h:0,providerCalls1h:0,providerSuccesses1h:0,providerFailures1h:0,providerOutageGroups1h:0,spend24hUsd:0,spendMonthUsd:0,accountsAtOrOverBudget:0},vitals:{heapFraction:ratio,heapUsedMb:ratio*1000,heapLimitMb:1000,rssMb:1100,uptimeSeconds:100,db:{waiting:0}}}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
async function run(value,expectedExit){
 ratio=value;
 const child=spawn(process.execPath,['scripts/verify-operational-status.mjs'],{env:{...process.env,WORKER_STATUS_URL:`http://127.0.0.1:${server.address().port}/status`,WORKER_STATUS_TOKEN:'PRIVATE_TOKEN_MARKER',OPERATIONAL_EXPECTED_SHA:commit,OPERATIONAL_SAMPLE_INTERVAL_MS:'0'}});
 let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
 const code=await new Promise(resolve=>child.on('close',resolve));
 assert.equal(code,expectedExit);
 assert.ok(!output.includes('PRIVATE_BODY_MARKER')&&!output.includes('PRIVATE_TOKEN_MARKER'));
 if(expectedExit) { assert.match(output,/heapFraction=0.85/);assert.match(output,/heapUsedMb=850/);assert.match(output,/sample 3 at/); }
 else {assert.match(output,/Operational attention/);assert.doesNotMatch(output,/Operational gate failed/);}
 console.log(JSON.stringify({ratio,exit:code,privateMarkersAbsent:true,output}));
}
try {await run(0.846,0);await run(0.85,1);} finally {await new Promise(resolve=>server.close(resolve));}
