/**
 * Effective sequential database round trips per page: the p50 with 20 ms added to every packet the
 * interface sends to PostgreSQL, less the p50 with none, over 20. A page whose statements run in
 * parallel pays the delay once per wave, not once per statement, so this is the number of waves the
 * render waits through, which is what latency to a remote database multiplies.
 *
 *   DATABASE_URL=postgres://…/ava_perf_ci node scripts/perf/roundtrips.mjs perf-out/fixture.json [out.json]
 *
 * Knobs: PERF_PORT (3185), PERF_RELAY_PORT (55485), PERF_POOL (6: production's pooled default),
 * PERF_DELAY_MS (20), PERF_N (8, after two discarded).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertPerfDatabase, startRelay, startServer, viaRelay } from "./lib.mjs";
import { pathKey } from "./pages.mjs";

export function roundtripPaths(fixture) {
  return ["/", "/?view=auto-matched", "/companies", "/companies?tab=discover", `/companies/${fixture.company1}`, "/applications",
    "/library", `/cv/${fixture.draft1}`, "/suggestions", "/settings", "/learning", "/health", "/account",
    "/api/work-status?scope=company", "/api/scan-status"];
}

/** The middle of n timings as the audit took it: the mean of the two central values of eight. */
export function centralMs(ms) {
  const sorted = [...ms].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return Number.isInteger(mid) ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[Math.floor(mid)];
}

/** Round trips from the two p50s, to one decimal. */
export function effectiveRoundTrips(p50AtZero, p50Delayed, delayMs) {
  return +((p50Delayed - p50AtZero) / delayMs).toFixed(1);
}

async function timings(base, cookie, paths, n) {
  const out = {};
  for (const path of paths) {
    const ms = [];
    for (let i = 0; i < n + 2; i++) {
      const start = performance.now();
      const response = await fetch(base + path, { headers: { cookie }, redirect: "manual" });
      await response.arrayBuffer();
      if (i >= 2) ms.push(performance.now() - start);
    }
    out[path] = centralMs(ms);
  }
  return out;
}

export async function measureRoundTrips({ databaseUrl, fixture, port, relayPort, pool, delayMs, n }) {
  const paths = roundtripPaths(fixture);
  const target = new URL(databaseUrl);
  const byDelay = {};
  for (const delay of [0, delayMs]) {
    const relay = await startRelay({ port: relayPort, target: { host: target.hostname, port: Number(target.port || 5432) }, delayMs: delay });
    const server = await startServer({ port, databaseUrl: viaRelay(databaseUrl, relayPort), pool });
    try { byDelay[delay] = await timings(`http://127.0.0.1:${port}`, fixture.cookie1, paths, n); }
    finally { await server.stop(); await relay.close(); }
  }
  return Object.fromEntries(paths.map(path => [pathKey(path, fixture), {
    p50AtZero: +byDelay[0][path].toFixed(1), p50Delayed: +byDelay[delayMs][path].toFixed(1),
    roundTrips: effectiveRoundTrips(byDelay[0][path], byDelay[delayMs][path], delayMs),
  }]));
}

async function main() {
  const databaseUrl = assertPerfDatabase(process.env.DATABASE_URL ?? "").href;
  const fixture = JSON.parse(readFileSync(resolve(process.argv[2] ?? "perf-out/fixture.json"), "utf8"));
  const out = resolve(process.argv[3] ?? "perf-out/roundtrips.json");
  const results = await measureRoundTrips({
    databaseUrl, fixture, port: Number(process.env.PERF_PORT ?? 3185), relayPort: Number(process.env.PERF_RELAY_PORT ?? 55485),
    pool: Number(process.env.PERF_POOL ?? 6), delayMs: Number(process.env.PERF_DELAY_MS ?? 20), n: Number(process.env.PERF_N ?? 8),
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(results, null, 1));
  console.table(results);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
