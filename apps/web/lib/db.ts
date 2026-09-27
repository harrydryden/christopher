import { attachDatabasePool } from "@vercel/functions/db-connections";
import { createDb, renderEndpoint } from "@ava/db/client";
export type Db = ReturnType<typeof createDb>["db"];
let cached: Db | null = null;

/** The pool on the direct endpoint, where every connection is a database backend. */
export const DIRECT_POOL_MAX = 3;
/** The pool through PgBouncer, where a connection is a client that holds no backend while idle. */
export const POOLED_POOL_MAX = 6;

/** PgBouncer's endpoint: Render's port 6432, or a host named as a pooler. */
function isPooledUrl(url: string): boolean {
  if (renderEndpoint(url) === "pooled") return true;
  try {
    return new URL(url).hostname.split(".")[0]!.endsWith("-pooler");
  } catch {
    return false;
  }
}

/**
 * How many connections one instance's pool may open.
 *
 * On the direct endpoint every connection is a backend: about 30 warm instances at 3 each, beside
 * the worker's 26, reach the database's 100 usable backends (docs/DEPLOY.md). Through PgBouncer a
 * connection is a client, and a backend is lent to it only for a transaction in flight, so a wider
 * pool costs no backends while idle and PgBouncer's own pool still bounds them under load. There
 * the pool was the bottleneck instead: a full render of `/` issues about 14 statements, most at the
 * instant the session resolves, and at 3 wide they queue in waves of one network round trip each.
 * Replaying that render's statements with 5 ms per round trip, time to the main content went from
 * 70 ms at 3 to 54 ms at 6 (47 ms at 10). What 6 costs is PgBouncer client slots: instances × 6
 * must stay under its client-connection limit, which is the figure to check when instances grow.
 *
 * `WEB_DB_POOL_MAX` (a whole number from 1 to 20) overrides either default; anything else is ignored.
 */
export function webPoolMax(url: string, override: string | undefined = process.env.WEB_DB_POOL_MAX): number {
  const requested = override?.trim() ? Number(override) : NaN;
  if (Number.isInteger(requested) && requested >= 1 && requested <= 20) return requested;
  return isPooledUrl(url) ? POOLED_POOL_MAX : DIRECT_POOL_MAX;
}

/** How long an idle connection through PgBouncer stays open: two minutes of reading without a reconnect. */
export const POOLED_IDLE_TIMEOUT_MS = 120_000;
/** How long an idle connection on the direct endpoint stays open, where it holds a backend all the while. */
export const DIRECT_IDLE_TIMEOUT_MS = 30_000;

/**
 * How long an instance keeps an idle connection before closing it.
 *
 * A new connection costs TCP, the SSL request, TLS 1.3 and PgBouncer's SCRAM exchange: about five
 * round trips before the first statement, for each of the pool's connections. At 30 seconds idle,
 * the first navigation after anyone paused to read paid that again, up to six times in parallel.
 * Through PgBouncer an idle connection is a client slot and no backend, and Render's pooler keeps
 * idle clients for a day (`client_idle_timeout` 86,400 s), so two minutes costs nothing there. On
 * the direct endpoint an idle connection is a backend the worker may need, so it stays 30 seconds.
 */
export function webPoolIdleTimeoutMs(url: string): number {
  return isPooledUrl(url) ? POOLED_IDLE_TIMEOUT_MS : DIRECT_IDLE_TIMEOUT_MS;
}

/** Shared connection policy, with a small serverless pool. Direct subpath avoids migrations. */
export function db(): Db {
  if (!cached) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    // Statements bounded at 30 s: a request-serving process must never hold a connection open
    // across a hung query, and Render's database is shared with the worker. A transaction left
    // idle for 30 s is closed for the same reason. The pool's width is `webPoolMax`'s and its idle
    // time `webPoolIdleTimeoutMs`'s. The first connection of each instance logs its round trip to
    // the database (`database_round_trip`).
    const { db: created, pool } = createDb(url, {
      max: webPoolMax(url),
      idleTimeoutMillis: webPoolIdleTimeoutMs(url),
      statementTimeoutMs: 30_000,
      idleInTransactionTimeoutMs: 30_000,
      reportRoundTrip: true,
    });
    // Fluid compute suspends an instance once its responses are done. Without this, a pool's idle
    // connections are frozen open and found dead on the next thaw; with it, each release keeps the
    // instance alive (through `waitUntil`) until the idle timeout has closed them cleanly. Outside
    // Vercel it does nothing.
    attachDatabasePool(pool);
    cached = created;
  }
  return cached;
}
