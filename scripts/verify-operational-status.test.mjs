import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const commit = "a".repeat(40);

test("the operational CLI fails on sustained heap pressure and prints safe, useful samples", async () => {
  const fractions = [0.846, 0.851, 0.86];
  let requested = 0;
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer local-test-token");
    const heapFraction = fractions[Math.min(requested++, fractions.length - 1)];
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true, commit, workerId: "test-worker", privatePayload: "do-not-print-this",
      metrics: {
        ready: 0, running: 0, oldest_seconds: 0, overdueCompanies: 0, overdueDiscovery: 0,
        crashRecoveries1h: 0, crashRecoveries24h: 0, providerCalls1h: 0, providerSuccesses1h: 0,
        providerFailures1h: 0, providerOutageGroups1h: 0, spend24hUsd: 0, spendMonthUsd: 0,
        accountsAtOrOverBudget: 0,
      },
      vitals: { heapFraction, heapUsedMb: Math.round(heapFraction * 258), heapLimitMb: 258, rssMb: 403,
        uptimeSeconds: 100 + requested, db: { waiting: 0 } },
    }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    let failure;
    try {
      await run(process.execPath, ["scripts/verify-operational-status.mjs"], {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        env: { ...process.env, OPERATIONAL_EXPECTED_SHA: commit,
          WORKER_STATUS_URL: `http://127.0.0.1:${address.port}/status`, WORKER_STATUS_TOKEN: "local-test-token",
          OPERATIONAL_SAMPLE_INTERVAL_MS: "0" },
      });
    } catch (error) { failure = error; }
    assert.equal(failure?.code, 1);
    assert.equal(requested, 3);
    const output = failure.stderr;
    assert.match(output, /Operational gate failed:[\s\S]*worker heap pressure is sustained at or above 85%/);
    assert.match(output, /sample 1 at \d{4}-\d\d-\d\dT[^\s]+ from "test-worker": heapUsedMb=218, heapLimitMb=258, heapFraction=0\.846, rssMb=403/);
    assert.match(output, /sample 2 at \d{4}-\d\d-\d\dT[^\s]+ from "test-worker": heapUsedMb=220, heapLimitMb=258, heapFraction=0\.851, rssMb=403/);
    assert.match(output, /sample 3 at \d{4}-\d\d-\d\dT[^\s]+ from "test-worker": heapUsedMb=222, heapLimitMb=258, heapFraction=0\.86, rssMb=403/);
    assert.doesNotMatch(output, /do-not-print-this|local-test-token/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
