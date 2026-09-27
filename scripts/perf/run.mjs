/**
 * The weekly re-run of the audit measurements, compared with scripts/perf/baseline.json.
 *
 *   createdb ava_perf_ci && DATABASE_URL=… pnpm db:migrate && pnpm --filter @ava/web build
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/ava_perf_ci node scripts/perf/run.mjs [--no-decide]
 *
 * Seeds the fixture into the (empty, ava_perf*) database, then runs pages.mjs, roundtrips.mjs and
 * decide.mjs in that order (decide last: it records decisions) and fails on one statement more,
 * one round trip more or 10 % more bytes than the baseline on any page, or on the decision. Counts
 * are the stable figures; milliseconds on a shared runner are reported and never gated. The report
 * goes to perf-out/report.json and, in GitHub Actions, to the step summary.
 */
import { createRequire } from "node:module";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { seedFixture } from "./fixture.mjs";
import { assertPerfDatabase, startRelay, startServer, viaRelay } from "./lib.mjs";
import { measurePages, pagePaths } from "./pages.mjs";
import { measureRoundTrips } from "./roundtrips.mjs";
import { measureDecisions, summariseDecisions } from "./decide.mjs";

export const TOLERANCE = Object.freeze({ statements: 1, roundTrips: 1, bytesFraction: 0.1 });

/**
 * The measurements against the baseline: a row per page and the failures. A page or figure the
 * baseline does not hold is reported and not gated; one the run did not measure is a failure, so
 * a page that stops rendering cannot pass by absence.
 */
export function compareWithBaseline(baseline, { pages, roundTrips, decision }, tolerance = TOLERANCE) {
  const failures = [];
  const rows = [];
  const over = (label, measured, allowed, unit) => failures.push(`${label}: ${measured} ${unit}, baseline allows under ${allowed}`);
  for (const [path, base] of Object.entries(baseline.pages)) {
    const html = pages?.[`html ${path}`], rsc = pages?.[`rsc ${path}`], rt = roundTrips?.[path];
    const row = { path, statements: html?.statements ?? null, roundTrips: rt?.roundTrips ?? null, htmlGzip: html?.gzip ?? null, rscBytes: rsc?.bytes ?? null, p50Ms: html?.p50Ms ?? null, base };
    rows.push(row);
    if (!html) { failures.push(`${path}: not measured`); continue; }
    if (html.status !== "200") failures.push(`${path}: answered ${html.status}`);
    if (typeof base.statements === "number" && html.statements >= base.statements + tolerance.statements) over(path, html.statements, base.statements + tolerance.statements, "statements");
    if (typeof base.roundTrips === "number") {
      if (!rt) failures.push(`${path}: round trips not measured`);
      else if (rt.roundTrips >= base.roundTrips + tolerance.roundTrips) over(path, rt.roundTrips, +(base.roundTrips + tolerance.roundTrips).toFixed(1), "round trips");
    }
    if (typeof base.htmlGzip === "number" && html.gzip > base.htmlGzip * (1 + tolerance.bytesFraction)) over(path, html.gzip, Math.floor(base.htmlGzip * (1 + tolerance.bytesFraction)) + 1, "HTML gzip bytes");
    if (typeof base.rscBytes === "number" && rsc && rsc.bytes > base.rscBytes * (1 + tolerance.bytesFraction)) over(path, rsc.bytes, Math.floor(base.rscBytes * (1 + tolerance.bytesFraction)) + 1, "RSC bytes");
  }
  if (baseline.decision) {
    const base = baseline.decision;
    if (!decision) failures.push("decision: not measured");
    else {
      if (decision.requests >= base.requests + 1) over("decision", decision.requests, base.requests + 1, "requests");
      if (decision.statements >= base.statements + tolerance.statements) over("decision", decision.statements, base.statements + tolerance.statements, "statements");
      if (decision.bytes > base.bytes * (1 + tolerance.bytesFraction)) over("decision", decision.bytes, Math.floor(base.bytes * (1 + tolerance.bytesFraction)) + 1, "bytes");
    }
  }
  return { rows, failures };
}

/** Per page, the pass with the fewest round trips. */
export function lowestRoundTrips(passes) {
  const out = {};
  for (const pass of passes) for (const [path, reading] of Object.entries(pass)) {
    if (!out[path] || reading.roundTrips < out[path].roundTrips) out[path] = reading;
  }
  return out;
}

export function markdownReport({ rows, failures }, decision) {
  const cell = (measured, base) => (measured === null ? "–" : base === undefined ? `${measured}` : `${measured} (${base})`);
  const lines = ["### Audit measurements against scripts/perf/baseline.json", "", "| path | statements | round trips (pool 6) | HTML gzip | RSC bytes | p50 ms |", "|---|---:|---:|---:|---:|---:|"];
  for (const row of rows) lines.push(`| \`${row.path}\` | ${cell(row.statements, row.base.statements)} | ${cell(row.roundTrips, row.base.roundTrips)} | ${cell(row.htmlGzip, row.base.htmlGzip)} | ${cell(row.rscBytes, row.base.rscBytes)} | ${row.p50Ms ?? "–"} |`);
  if (decision) lines.push("", `One shortlist decision: ${decision.requests} request(s), ${decision.bytes} B, ${decision.statements} statements, row gone after ${decision.rowGoneMs} ms.`);
  lines.push("", failures.length ? `**Regressions:**\n\n- ${failures.join("\n- ")}\n\nIf the change is intended, update scripts/perf/baseline.json in the same pull request and say why.` : "Every figure is within the baseline.");
  return lines.join("\n") + "\n";
}

async function main() {
  const databaseUrl = assertPerfDatabase(process.env.DATABASE_URL ?? "").href;
  const port = Number(process.env.PERF_PORT ?? 3185), relayPort = Number(process.env.PERF_RELAY_PORT ?? 55485), n = Number(process.env.PERF_N ?? 8);
  const baseline = JSON.parse(readFileSync(new URL("./baseline.json", import.meta.url), "utf8"));
  mkdirSync("perf-out", { recursive: true });
  const { Pool } = createRequire(new URL("../../apps/web/package.json", import.meta.url))("pg");
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  let fixture;
  try { fixture = await seedFixture(pool); } finally { await pool.end(); }
  writeFileSync("perf-out/fixture.json", JSON.stringify(fixture, null, 1));
  const target = new URL(databaseUrl);
  const upstream = { host: target.hostname, port: Number(target.port || 5432) };

  // Pages and the decision share one counting relay and one server on the direct pool.
  let pages, decision;
  {
    const relay = await startRelay({ port: relayPort, target: upstream });
    const server = await startServer({ port, databaseUrl: viaRelay(databaseUrl, relayPort) });
    try {
      pages = await measurePages({ base: `http://127.0.0.1:${port}`, cookie: fixture.cookie1, paths: pagePaths(fixture), n, counter: relay.counter, fixture });
    } finally { await server.stop(); await relay.close(); }
  }
  // Round trips are a difference of two timings, and a busy runner inflates the delayed one: two
  // passes, the lower per page. Load adds to the figure; nothing takes a real round trip away.
  const passes = [];
  for (let i = 0; i < Number(process.env.PERF_RT_PASSES ?? 2); i++) passes.push(await measureRoundTrips({ databaseUrl, fixture, port, relayPort, pool: baseline.pool, delayMs: baseline.delayMs, n }));
  const roundTrips = lowestRoundTrips(passes);
  if (!process.argv.includes("--no-decide")) {
    const relay = await startRelay({ port: relayPort, target: upstream });
    const server = await startServer({ port, databaseUrl: viaRelay(databaseUrl, relayPort) });
    try {
      decision = summariseDecisions(await measureDecisions({ base: `http://127.0.0.1:${port}`, cookie: fixture.cookie1, counter: relay.counter, rounds: Number(process.env.PERF_ROUNDS ?? 5) }));
    } finally { await server.stop(); await relay.close(); }
  }
  const verdict = compareWithBaseline(process.argv.includes("--no-decide") ? { ...baseline, decision: undefined } : baseline, { pages, roundTrips, decision });
  writeFileSync("perf-out/report.json", JSON.stringify({ at: new Date().toISOString(), passed: !verdict.failures.length, ...verdict, pages, roundTrips, decision }, null, 1));
  const report = markdownReport(verdict, decision);
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  if (verdict.failures.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
