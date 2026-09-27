/**
 * What one role decision costs: requests, bytes and statements from pressing Enter on a shortlist
 * until the network is idle, and how long the row takes to leave the table, in Chromium through
 * Playwright on `/?view=auto-matched` as load user 1 (docs/performance/A-after.md §5).
 *
 *   DATABASE_URL=postgres://…/ava_perf_ci node scripts/perf/decide.mjs perf-out/fixture.json [out.json]
 *
 * Knobs: PERF_PORT (3185), PERF_RELAY_PORT (55485), PERF_ROUNDS (5). Run it after the page
 * measurements: each round records a decision for load user 1, which changes the tables they read.
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { assertPerfDatabase, median, startRelay, startServer, viaRelay } from "./lib.mjs";

/**
 * One round from the requests the page made after Enter: how many, their bytes, how many were
 * server actions, and the statements the relay counted (with BEGIN and COMMIT, as the log counted).
 */
export function summariseRound(requests, statements, rowGoneMs) {
  return {
    requests: requests.length,
    actions: requests.filter(r => r.action).length,
    bytes: requests.reduce((sum, r) => sum + (r.bytes ?? 0), 0),
    statements,
    rowGoneMs,
  };
}

/** The rounds' medians, the figures the baseline holds. */
export function summariseDecisions(rounds) {
  return {
    rounds: rounds.length,
    requests: median(rounds.map(r => r.requests)),
    bytes: median(rounds.map(r => r.bytes).filter(b => b > 0)),
    statements: median(rounds.map(r => r.statements)),
    rowGoneMs: median(rounds.map(r => r.rowGoneMs)),
  };
}

export async function measureDecisions({ base, cookie, counter, rounds }) {
  const require = createRequire(new URL("../../apps/worker/package.json", import.meta.url));
  const { chromium } = require("playwright");
  const [name, value] = cookie.split(/=(.*)/s);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.addCookies([{ name, value, domain: "127.0.0.1", path: "/", httpOnly: true }]);
    const page = await context.newPage();
    let log = [];
    page.on("request", request => {
      if (!request.url().startsWith(base)) return;
      const entry = { action: !!request.headers()["next-action"], bytes: 0 };
      log.push(entry);
      request.response().then(async response => { try { entry.bytes = (await response?.body())?.length ?? 0; } catch { /* body released */ } }).catch(() => {});
    });
    await page.goto(`${base}/?view=auto-matched`);
    await page.waitForLoadState("networkidle");
    await sleep(1_500);
    const out = [];
    for (let round = 0; round < rounds; round++) {
      const rowId = await page.locator("[id^=role-row-]").first().getAttribute("id");
      await page.keyboard.press("a");
      await page.waitForSelector("textarea", { timeout: 10_000 });
      await page.waitForLoadState("networkidle");
      await sleep(800);
      log = [];
      const before = counter.statements;
      const start = Date.now();
      await page.keyboard.press("Enter");
      await page.waitForSelector(`#${rowId}`, { state: "detached", timeout: 15_000 });
      const rowGoneMs = Date.now() - start;
      await page.waitForLoadState("networkidle");
      await sleep(2_000);
      out.push(summariseRound(log, counter.statements - before, rowGoneMs));
    }
    return out;
  } finally { await browser.close(); }
}

async function main() {
  const databaseUrl = assertPerfDatabase(process.env.DATABASE_URL ?? "").href;
  const fixture = JSON.parse(readFileSync(resolve(process.argv[2] ?? "perf-out/fixture.json"), "utf8"));
  const out = resolve(process.argv[3] ?? "perf-out/decide.json");
  const port = Number(process.env.PERF_PORT ?? 3185), relayPort = Number(process.env.PERF_RELAY_PORT ?? 55485);
  const target = new URL(databaseUrl);
  const relay = await startRelay({ port: relayPort, target: { host: target.hostname, port: Number(target.port || 5432) } });
  const server = await startServer({ port, databaseUrl: viaRelay(databaseUrl, relayPort) });
  try {
    const rounds = await measureDecisions({ base: `http://127.0.0.1:${port}`, cookie: fixture.cookie1, counter: relay.counter, rounds: Number(process.env.PERF_ROUNDS ?? 5) });
    const result = { rounds, summary: summariseDecisions(rounds) };
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(result, null, 1));
    console.log(JSON.stringify(result.summary));
  } finally { await server.stop(); await relay.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
