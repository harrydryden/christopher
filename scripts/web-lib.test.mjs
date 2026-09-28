import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { localDatabaseUrl } from "./lib/database.mjs";
import { startWeb } from "./lib/web.mjs";

const groupAlive = pid => { try { process.kill(-pid, 0); return true; } catch { return false; } };
const freePort = () => new Promise(resolve => {
  const server = createServer().listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

test("startWeb returns once /api/health answers, and stop takes the whole process group down", async () => {
  // A stub answers the health check; the `next start` it spawns finds the port taken, which is fine:
  // what is under test is the poll and the stop.
  const health = createServer((request, response) => { response.statusCode = request.url === "/api/health" ? 200 : 404; response.end(); });
  const port = await new Promise(resolve => health.listen(0, "127.0.0.1", () => resolve(health.address().port)));
  try {
    const web = await startWeb({ port, intervalMs: 20, probeTimeoutMs: 1000 });
    assert.equal(typeof web.child.pid, "number");
    await web.stop({ graceMs: 1000 });
    assert.equal(groupAlive(web.child.pid), false);
  } finally {
    await new Promise(resolve => health.close(resolve));
  }
});

test("startWeb stops the server and says so when health never answers", async () => {
  const port = await freePort();
  await assert.rejects(startWeb({ port, attempts: 2, intervalMs: 20, probeTimeoutMs: 200, env: { DATABASE_URL: "postgres://127.0.0.1:1/none" } }),
    new RegExp(`did not start on :${port}`));
});

test("localDatabaseUrl accepts one loopback list and refuses with the caller's message", () => {
  for (const host of ["127.0.0.1", "localhost", "[::1]"])
    assert.equal(localDatabaseUrl(`postgres://u@${host}:5432/scratch`, { name: "scratch", message: "no" }).pathname, "/scratch");
  for (const bad of ["not a url", "mysql://u@localhost/scratch", "postgres://u@db.example.com/scratch", "postgres://u@localhost/other", "postgres://u@localhost/scratch_x"])
    assert.throws(() => localDatabaseUrl(bad, { name: /^scratch$/, message: "refused" }), /^Error: refused$/, bad);
  assert.throws(() => localDatabaseUrl("postgres://u@localhost/scratch_christopher_dev", { name: /^scratch/, forbid: /christopher_/, message: "refused" }), /refused/);
});
