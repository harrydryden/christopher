import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { assertPerfDatabase, frontendReader, isStatement, median, percentile, sessionCookie, startRelay, viaRelay } from "./lib.mjs";
import { pagePaths, pathKey, summarisePage } from "./pages.mjs";
import { centralMs, effectiveRoundTrips, roundtripPaths } from "./roundtrips.mjs";
import { summariseDecisions, summariseRound } from "./decide.mjs";
import { compareWithBaseline, lowestRoundTrips, markdownReport } from "./run.mjs";

const baseline = JSON.parse(readFileSync(new URL("./baseline.json", import.meta.url), "utf8"));
const fixture = { company1: "11111111-1111-1111-1111-111111111111", draft1: "22222222-2222-2222-2222-222222222222", cookie1: "c" };

test("only a local ava_perf* database is accepted", () => {
  assert.equal(assertPerfDatabase("postgres://u:p@127.0.0.1:5432/ava_perf_ci").pathname, "/ava_perf_ci");
  assert.equal(assertPerfDatabase("postgresql://u@localhost/ava_perf_bench").pathname, "/ava_perf_bench");
  for (const unsafe of ["postgres://u@db.example.com/ava_perf_ci", "postgres://u@localhost/col_test", "postgres://u@localhost/christopher_dev",
    "postgres://u@localhost/ava_perf-x", "mysql://u@localhost/ava_perf", "not a url"])
    assert.throws(() => assertPerfDatabase(unsafe), /ava_perf/, unsafe);
});

/** A frontend message: type byte, length counting itself, body. */
const message = (type, body = Buffer.alloc(0)) => { const head = Buffer.alloc(5); head.write(type, 0); head.writeInt32BE(4 + body.length, 1); return Buffer.concat([head, body]); };
const startup = code => { const b = Buffer.alloc(8); b.writeInt32BE(8, 0); b.writeInt32BE(code, 4); return b; };

test("the wire reader counts simple queries and executes, across chunk boundaries and after an SSL request", () => {
  const seen = [];
  const read = frontendReader(type => seen.push(type));
  const stream = Buffer.concat([startup(80877103), startup(196608), message("Q", Buffer.from("select 1\0")),
    message("P", Buffer.from("\0select $1\0\0\0")), message("B", Buffer.alloc(10)), message("D", Buffer.from("P\0")), message("E", Buffer.alloc(5)), message("S"),
    message("Q", Buffer.from("begin\0"))]);
  for (let i = 0; i < stream.length; i += 3) read(stream.subarray(i, i + 3));
  assert.deepEqual(seen, ["Q", "P", "B", "D", "E", "S", "Q"]);
  assert.equal(seen.filter(isStatement).length, 3);
});

test("percentiles, medians and the audits' page summary", () => {
  assert.equal(percentile([30, 10, 20], 0.5), 20);
  assert.equal(percentile([], 0.5), null);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  const samples = [{ ms: 900, status: 200, bytes: 1, gzip: 1, statements: 30 }, { ms: 800, status: 200, bytes: 1, gzip: 1, statements: 30 },
    ...[10, 12, 11, 13].map(ms => ({ ms, status: 200, bytes: 1000, gzip: 200, statements: 14 }))];
  assert.deepEqual(summarisePage(samples), { n: 4, status: "200", p50Ms: 12, p95Ms: 13, bytes: 1000, gzip: 200, statements: 14, statementsMin: 14, statementsMax: 14 });
  assert.equal(pathKey(`/companies/${fixture.company1}`, fixture), "/companies/<id>");
  assert.equal(pathKey(`/cv/${fixture.draft1}`, fixture), "/cv/<draftId>");
});

test("every page the baseline holds is one the scripts measure", () => {
  const measured = new Set(pagePaths(fixture).map(p => pathKey(p, fixture)));
  const timed = new Set(roundtripPaths(fixture).map(p => pathKey(p, fixture)));
  for (const [path, base] of Object.entries(baseline.pages)) {
    assert.ok(measured.has(path), path);
    if (typeof base.roundTrips === "number") assert.ok(timed.has(path), path);
  }
  assert.equal(baseline.pool, 6);
  assert.equal(baseline.pages["/"].statements, 13);
  assert.equal(baseline.pages["/companies/<id>"].roundTrips, 7.6);
});

test("round trips are the delayed p50 less the undelayed, over the delay", () => {
  assert.equal(centralMs([5, 1, 9, 3, 7, 2, 8, 4]), 4.5);
  assert.equal(effectiveRoundTrips(65.7, 160.9, 20), 4.8);
  assert.equal(effectiveRoundTrips(66, 220.9, 20), 7.7);
});

test("of two round-trip passes, each page keeps the lower", () => {
  assert.deepEqual(lowestRoundTrips([{ "/": { roundTrips: 5.7 }, "/x": { roundTrips: 2 } }, { "/": { roundTrips: 3.8 }, "/x": { roundTrips: 2.4 } }]),
    { "/": { roundTrips: 3.8 }, "/x": { roundTrips: 2 } });
});

test("a decision round and the rounds' medians", () => {
  const round = summariseRound([{ action: true, bytes: 92_856 }], 29, 25);
  assert.deepEqual(round, { requests: 1, actions: 1, bytes: 92_856, statements: 29, rowGoneMs: 25 });
  assert.deepEqual(summariseDecisions([round, { ...round, statements: 28, bytes: 0 }, { ...round, rowGoneMs: 30 }]), { rounds: 3, requests: 1, bytes: 92_856, statements: 29, rowGoneMs: 25 });
});

/** The measurements baseline.json describes, exactly. */
function atBaseline() {
  const pages = {}, roundTrips = {};
  for (const [path, base] of Object.entries(baseline.pages)) {
    pages[`html ${path}`] = { status: "200", statements: base.statements, gzip: base.htmlGzip ?? 50, p50Ms: 40 };
    pages[`rsc ${path}`] = { status: "200", statements: base.statements, bytes: base.rscBytes ?? 50 };
    roundTrips[path] = { roundTrips: base.roundTrips };
  }
  return { pages, roundTrips, decision: { ...baseline.decision, rowGoneMs: 25 } };
}

test("the baseline's own figures pass, and one statement, one round trip or 10 % more bytes fails", () => {
  assert.deepEqual(compareWithBaseline(baseline, atBaseline()).failures, []);
  const m = atBaseline();
  const statementLimit = baseline.pages["/"].statements + 1;
  const roundTripLimit = baseline.pages["/companies/<id>"].roundTrips + 1;
  const byteLimit = Math.ceil(baseline.pages["/library"].rscBytes * 1.1);
  const decisionLimit = baseline.decision.statements + 1;
  m.pages["html /"].statements = statementLimit;
  m.roundTrips["/companies/<id>"].roundTrips = roundTripLimit;
  m.pages["rsc /library"].bytes = byteLimit + 1;
  m.pages["html /account"].gzip = Math.floor(baseline.pages["/account"].htmlGzip * 1.1);
  m.decision.statements = decisionLimit;
  const { failures } = compareWithBaseline(baseline, m);
  assert.deepEqual(failures, [
    `/: ${statementLimit} statements, baseline allows under ${statementLimit}`,
    `/companies/<id>: ${roundTripLimit} round trips, baseline allows under ${roundTripLimit}`,
    `/library: ${byteLimit + 1} RSC bytes, baseline allows under ${byteLimit}`,
    `decision: ${decisionLimit} statements, baseline allows under ${decisionLimit}`,
  ]);
  // Half a round trip of noise is not a regression.
  const noisy = atBaseline();
  noisy.roundTrips["/"].roundTrips = baseline.pages["/"].roundTrips + 0.5;
  assert.deepEqual(compareWithBaseline(baseline, noisy).failures, []);
});

test("a page that stops rendering, or goes unmeasured, fails rather than passing by absence", () => {
  const m = atBaseline();
  m.pages["html /settings"].status = "500";
  delete m.pages["html /health"];
  delete m.roundTrips["/learning"];
  const { failures } = compareWithBaseline(baseline, { ...m, decision: undefined });
  assert.deepEqual(failures, ["/settings: answered 500", "/learning: round trips not measured", "/health: not measured", "decision: not measured"]);
  assert.match(markdownReport(compareWithBaseline(baseline, atBaseline()), atBaseline().decision), /Every figure is within the baseline/);
});

test("the relay counts the statements a real client sends, when a database is at hand", async t => {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) return t.skip("no database");
  const { Client } = createRequire(new URL("../../apps/web/package.json", import.meta.url))("pg");
  const target = new URL(url);
  const relay = await startRelay({ port: 55499, target: { host: target.hostname, port: Number(target.port || 5432) } });
  const client = new Client({ connectionString: viaRelay(url, 55499) });
  try {
    await client.connect();
    const before = relay.counter.statements;
    await client.query("select 1");
    await client.query("select $1::int as n", [2]);
    await client.query("begin");
    await client.query("commit");
    assert.equal(relay.counter.statements - before, 4);
  } catch (error) {
    if (error?.code === "ECONNREFUSED") return t.skip("database not reachable");
    throw error;
  } finally { await client.end().catch(() => {}); await relay.close(); }
});

test("the cookie is the interface's own shape", () => {
  assert.match(sessionCookie("s", "id", 1), /^col_session=v2\.id\.1\.[A-Za-z0-9_-]{43}$/);
});
