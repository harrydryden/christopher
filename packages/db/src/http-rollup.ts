import { desc, gte, sql } from "drizzle-orm";
import type { Db } from "./client";
import { httpHostDaily, type HttpVia } from "./schema";

export const LATENCY_BUCKET_UPPER_MS = [500, 1000, 2000, 5000, 15000, Infinity] as const;

/** One accumulated cell: everything a day of traffic to one host through one path added up to. */
export interface HttpHostCounters {
  requests: number;
  bytesIn: number;
  ok2xx: number;
  notModified304: number;
  redirects3xx: number;
  client4xx: number;
  server5xx: number;
  rateLimited: number;
  blocked: number;
  robotsDenied: number;
  capRejected: number;
  timeouts: number;
  networkErrors: number;
  durationMsSum: number;
  durationMsMax: number;
  latencyBuckets: number[];
}

export const emptyHttpCounters = (): HttpHostCounters => ({
  requests: 0, bytesIn: 0, ok2xx: 0, notModified304: 0, redirects3xx: 0, client4xx: 0, server5xx: 0,
  rateLimited: 0, blocked: 0, robotsDenied: 0, capRejected: 0, timeouts: 0, networkErrors: 0,
  durationMsSum: 0, durationMsMax: 0, latencyBuckets: [0, 0, 0, 0, 0, 0],
});

export function latencyBucketIndex(durationMs: number): number {
  const i = LATENCY_BUCKET_UPPER_MS.findIndex(upper => durationMs < upper);
  return i < 0 ? LATENCY_BUCKET_UPPER_MS.length - 1 : i;
}

export interface HttpHostDailyDelta extends HttpHostCounters {
  day: string;
  host: string;
  via: HttpVia;
}

/**
 * Add a batch of counters into the daily rows, one statement per cell. Adds, never replaces, so
 * two workers (or one worker restarted) flushing the same day and host both count. Never throws:
 * the ledger must not take a fetch down with it.
 */
export async function addHttpHostDaily(db: Db, deltas: HttpHostDailyDelta[]): Promise<void> {
  for (const d of deltas) {
    // A robots denial and a refused private address make no request, and are still worth a row.
    if (d.requests === 0 && d.robotsDenied === 0 && d.blocked === 0) continue;
    try {
      await db.execute(sql`
        insert into http_host_daily (day, host, via, requests, bytes_in, ok_2xx, not_modified_304, redirects_3xx, client_4xx, server_5xx,
          rate_limited, blocked, robots_denied, cap_rejected, timeouts, network_errors, duration_ms_sum, duration_ms_max, latency_buckets)
        values (${d.day}, ${d.host}, ${d.via}, ${d.requests}, ${d.bytesIn}, ${d.ok2xx}, ${d.notModified304}, ${d.redirects3xx}, ${d.client4xx}, ${d.server5xx},
          ${d.rateLimited}, ${d.blocked}, ${d.robotsDenied}, ${d.capRejected}, ${d.timeouts}, ${d.networkErrors}, ${d.durationMsSum}, ${d.durationMsMax},
          ${sql.raw(`'{${d.latencyBuckets.map(n => Math.trunc(n)).join(",")}}'::integer[]`)})
        on conflict (day, host, via) do update set
          requests = http_host_daily.requests + excluded.requests,
          bytes_in = http_host_daily.bytes_in + excluded.bytes_in,
          ok_2xx = http_host_daily.ok_2xx + excluded.ok_2xx,
          not_modified_304 = http_host_daily.not_modified_304 + excluded.not_modified_304,
          redirects_3xx = http_host_daily.redirects_3xx + excluded.redirects_3xx,
          client_4xx = http_host_daily.client_4xx + excluded.client_4xx,
          server_5xx = http_host_daily.server_5xx + excluded.server_5xx,
          rate_limited = http_host_daily.rate_limited + excluded.rate_limited,
          blocked = http_host_daily.blocked + excluded.blocked,
          robots_denied = http_host_daily.robots_denied + excluded.robots_denied,
          cap_rejected = http_host_daily.cap_rejected + excluded.cap_rejected,
          timeouts = http_host_daily.timeouts + excluded.timeouts,
          network_errors = http_host_daily.network_errors + excluded.network_errors,
          duration_ms_sum = http_host_daily.duration_ms_sum + excluded.duration_ms_sum,
          duration_ms_max = greatest(http_host_daily.duration_ms_max, excluded.duration_ms_max),
          latency_buckets = array(select coalesce(a.v, 0) + coalesce(b.v, 0)
            from unnest(http_host_daily.latency_buckets) with ordinality a(v, i)
            full join unnest(excluded.latency_buckets) with ordinality b(v, i) using (i) order by i)`);
    } catch {
      // Counters lost for one flush are a rounding error; a fetch failed because of its ledger is not.
    }
  }
}

/** One accumulated day of traffic to one host through one path, as it is stored. */
export type HttpHostDailyRow = typeof httpHostDaily.$inferSelect;

/** Rows for the last `days` days (UTC), newest first. */
export async function listHttpHostDaily(db: Db, days = 7): Promise<HttpHostDailyRow[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return db.select().from(httpHostDaily).where(gte(httpHostDaily.day, since)).orderBy(desc(httpHostDaily.day), httpHostDaily.host);
}

/**
 * A year of daily rows per host is small and answers "how did this vendor behave last spring".
 *
 * Bounded like every other statement in the hourly cleanup: the first run after a long-lived
 * deployment upgrades would otherwise delete a year of rows inside the maintenance transaction.
 * A cleanup that runs every hour catches up within a day.
 */
export async function pruneHttpHostDaily(db: Db, olderThanDays = 400, limit = 1000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString().slice(0, 10);
  const rows = await db.execute<{ day: string }>(sql`
    delete from http_host_daily where (day, host, via) in
      (select day, host, via from http_host_daily where day < ${cutoff} limit ${limit})
    returning day`);
  return rows.rows.length;
}
