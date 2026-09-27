/**
 * What the audit measurements share: the database guard, a local relay that counts the statements
 * the interface sends and can delay each packet, and a production server started behind it.
 *
 * Statements are counted from the PostgreSQL wire protocol rather than from the server log or
 * pg_stat_statements: every simple Query ('Q') and every extended-protocol Execute ('E') the
 * interface sends is one statement, which is what `log_min_duration_statement = 0` logged as an
 * `execute` or `statement` line in the audits. It needs no server setting and no preloaded library,
 * so it gives the same count on a laptop, in CI and on the audit host.
 */
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

export const BENCH_SECRET = "local-benchmark-only-0123456789abcdef0123456789abcdef";

/**
 * Only a local scratch database whose name starts with `ava_perf` (ava_perf_bench, ava_perf_ci, …):
 * the fixture writes a hundred accounts into it, and the measurements write sessions and decisions.
 */
export function assertPerfDatabase(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error("DATABASE_URL must name a local ava_perf scratch database"); }
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)
      || !/^ava_perf[a-z0-9_]*$/.test(database) || /christopher_/.test(database))
    throw new Error("DATABASE_URL must name a local scratch database whose name starts with ava_perf (never christopher_dev or christopher_test)");
  return url;
}

/** apps/web/lib/session.ts's cookie. */
export function sessionCookie(secret, sessionId, expiresEpochSeconds) {
  const sig = createHmac("sha256", secret).update(`${sessionId}.${expiresEpochSeconds}`).digest("base64url");
  return `ava_session=v2.${sessionId}.${expiresEpochSeconds}.${sig}`;
}

/** The value at fraction `p` of the sorted values (nearest rank, as the audits computed it). */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return Number.isInteger(mid) ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[Math.floor(mid)];
}

const SSL_REQUEST = 80877103;
const GSSENC_REQUEST = 80877104;
const CANCEL_REQUEST = 80877102;

/**
 * A reader for one connection's client-to-server stream: feed it chunks, it calls `onMessage(type)`
 * for every complete message after the startup packet. Frontend messages are a type byte and a
 * length that counts itself; the startup, SSL and cancel packets have no type byte.
 */
export function frontendReader(onMessage) {
  let buffer = Buffer.alloc(0);
  let started = false;
  return chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (!started) {
        if (buffer.length < 8) return;
        const length = buffer.readInt32BE(0);
        if (buffer.length < length) return;
        const code = buffer.readInt32BE(4);
        buffer = buffer.subarray(length);
        if (code !== SSL_REQUEST && code !== GSSENC_REQUEST && code !== CANCEL_REQUEST) started = true;
        continue;
      }
      if (buffer.length < 5) return;
      const length = buffer.readInt32BE(1);
      if (buffer.length < 1 + length) return;
      onMessage(String.fromCharCode(buffer[0]));
      buffer = buffer.subarray(1 + length);
    }
  };
}

/** Whether a frontend message is a statement: a simple query or an extended-protocol execute. */
export const isStatement = type => type === "Q" || type === "E";

/**
 * A relay on `port` to PostgreSQL at `target`, counting statements and adding `delayMs` to every
 * client-to-server chunk, in order, so each round trip to the database costs that much more.
 */
export function startRelay({ port, target = { host: "127.0.0.1", port: 5432 }, delayMs = 0 }) {
  const counter = { statements: 0 };
  const server = net.createServer(client => {
    const upstream = net.connect(target.port, target.host);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    const read = frontendReader(type => { if (isStatement(type)) counter.statements++; });
    let last = 0;
    client.on("data", chunk => {
      read(chunk);
      if (!delayMs) { upstream.write(chunk); return; }
      const at = Math.max(Date.now() + delayMs, last);
      last = at;
      setTimeout(() => upstream.write(chunk), at - Date.now());
    });
    upstream.on("data", chunk => client.write(chunk));
    const end = () => { client.destroy(); upstream.destroy(); };
    for (const socket of [client, upstream]) { socket.on("error", end); socket.on("close", end); }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ counter, close: () => new Promise(done => server.close(() => done())) }));
  });
}

/** The database URL with its host and port swapped for the relay's. */
export function viaRelay(databaseUrl, relayPort) {
  const url = new URL(databaseUrl);
  url.hostname = "127.0.0.1";
  url.port = String(relayPort);
  return url.toString();
}

/**
 * `next start` of the built interface on `port`, in its own process group so the whole group goes
 * on stop. `WEB_DB_POOL_MAX` sets the pool: 6 is production's pooled default, 3 the direct one.
 */
export async function startServer({ port, databaseUrl, pool }) {
  const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
  const nextBin = require.resolve("next/dist/bin/next");
  const env = { ...process.env, DATABASE_URL: databaseUrl, SESSION_SECRET: BENCH_SECRET, NODE_ENV: "production", AVA_DISABLE_BROWSER: "1" };
  if (pool) env.WEB_DB_POOL_MAX = String(pool);
  let log = "";
  const child = spawn(process.execPath, [nextBin, "start", "-p", String(port)], { cwd: new URL("../../apps/web", import.meta.url), env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => { log = (log + chunk).slice(-20_000); });
  child.stderr.on("data", chunk => { log = (log + chunk).slice(-20_000); });
  const stop = async () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } await sleep(300); };
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return { stop, log: () => log }; } catch { /* not up */ }
    await sleep(500);
  }
  await stop();
  throw new Error(`the server did not start on ${port}:\n${log}`);
}
