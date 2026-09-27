/**
 * Time, bytes and statements per page, signed in as load user 1: each path requested N+2 times as
 * HTML and again with `RSC: 1` (the first two discarded), through a statement-counting relay.
 *
 *   DATABASE_URL=postgres://…/ava_perf_ci node scripts/perf/pages.mjs perf-out/fixture.json [out.json]
 *
 * Knobs: PERF_PORT (3185), PERF_RELAY_PORT (55485), PERF_N (8), PERF_POOL (the web pool; unset is
 * the direct URL's default). Statements are counted per request between its start and 30 ms after
 * its body, as the audits' MARK statements bracketed it.
 */
import { gzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { assertPerfDatabase, median, percentile, startRelay, startServer, viaRelay } from "./lib.mjs";

export const RSC_HEADERS = Object.freeze({ RSC: "1", "Next-Router-State-Tree": "%5B%22%22%2C%7B%7D%5D" });

/** The audits' paths, with the fixture's company and CV. */
export function pagePaths(fixture) {
  return ["/", "/?view=auto-matched", "/companies", "/companies?tab=discover", `/companies/${fixture.company1}`,
    "/applications", "/library", "/cv", `/cv/${fixture.draft1}`, "/suggestions", "/settings", "/learning", "/health", "/account",
    "/api/work-status?scope=company", "/api/scan-status"];
}

/** A path with the fixture's ids replaced, so results from two fixtures compare by name. */
export function pathKey(path, fixture) {
  return path.replace(fixture.company1, "<id>").replace(fixture.draft1, "<draftId>");
}

/** One path's samples, after the warm-up is discarded, as the audits summarised them. */
export function summarisePage(samples, discard = 2) {
  const warm = samples.slice(discard);
  const ms = warm.map(s => s.ms);
  const statements = warm.map(s => s.statements);
  return {
    n: warm.length,
    status: [...new Set(warm.map(s => s.status))].join("/"),
    p50Ms: +percentile(ms, 0.5).toFixed(1),
    p95Ms: +percentile(ms, 0.95).toFixed(1),
    bytes: percentile(warm.map(s => s.bytes), 0.5),
    gzip: percentile(warm.map(s => s.gzip), 0.5),
    statements: median(statements),
    statementsMin: Math.min(...statements),
    statementsMax: Math.max(...statements),
  };
}

export async function measurePages({ base, cookie, paths, n, counter, fixture }) {
  const results = {};
  for (const [mode, headers] of [["html", {}], ["rsc", RSC_HEADERS]]) {
    for (const path of paths) {
      const samples = [];
      for (let i = 0; i < n + 2; i++) {
        const before = counter.statements;
        const start = performance.now();
        const response = await fetch(base + path, { headers: { cookie, ...headers }, redirect: "manual" });
        const body = Buffer.from(await response.arrayBuffer());
        const ms = performance.now() - start;
        await sleep(30);
        samples.push({ ms, status: response.status, bytes: body.length, gzip: gzipSync(body).length, statements: counter.statements - before });
      }
      results[`${mode} ${pathKey(path, fixture)}`] = summarisePage(samples);
    }
  }
  return results;
}

async function main() {
  const databaseUrl = assertPerfDatabase(process.env.DATABASE_URL ?? "").href;
  const fixture = JSON.parse(readFileSync(resolve(process.argv[2] ?? "perf-out/fixture.json"), "utf8"));
  const out = resolve(process.argv[3] ?? "perf-out/pages.json");
  const port = Number(process.env.PERF_PORT ?? 3185), relayPort = Number(process.env.PERF_RELAY_PORT ?? 55485);
  const target = new URL(databaseUrl);
  const relay = await startRelay({ port: relayPort, target: { host: target.hostname, port: Number(target.port || 5432) } });
  const server = await startServer({ port, databaseUrl: viaRelay(databaseUrl, relayPort), pool: process.env.PERF_POOL });
  try {
    const results = await measurePages({ base: `http://127.0.0.1:${port}`, cookie: fixture.cookie1, paths: pagePaths(fixture), n: Number(process.env.PERF_N ?? 8), counter: relay.counter, fixture });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(results, null, 1));
    for (const [key, r] of Object.entries(results)) console.log([key.padEnd(40), r.status, r.p50Ms, r.p95Ms, r.bytes, r.gzip, r.statements].join(" | "));
  } finally { await server.stop(); await relay.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
