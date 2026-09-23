/**
 * What the deployment asked of other people's servers, folded into one line per host.
 *
 * `http_host_daily` is a counter per host, per path (the polite fetcher or the headless browser)
 * and per day. Operations does not care which path a request took except as a share — a board that
 * is 90% browser is a board costing Chromium time — so the two are merged and the share reported
 * beside the total. Everything here is pure: the rows come from `listHttpHostDaily`.
 *
 * Latency is a histogram, not a list of samples, so p95 is the upper bound of the bucket the
 * cumulative count crosses 95% in. That is an over-estimate within one bucket's width, which is
 * the right direction for a number read as "are they slow": it never flatters a vendor. The top
 * bucket is unbounded, so a host whose 95th percentile falls in it reports null — "over 15s".
 */
import { LATENCY_BUCKET_UPPER_MS, type HttpHostDailyRow } from "@ava/db";

export interface HostTraffic {
  host: string;
  requests: number;
  bytes: number;
  /** Share of this host's requests that went through the headless browser, 0–1. */
  browserShare: number;
  /** Share revalidated away: a 304 is a request that cost a round trip and no transfer. */
  notModifiedRatio: number;
  /** Share the host answered with 429 or a Retry-After: the throttling signal. */
  rateLimitedRatio: number;
  blocked: number;
  robotsDenied: number;
  capRejected: number;
  errors: number;
  /** Upper bound of the bucket the 95th percentile falls in; null when that is the open top bucket. */
  p95Ms: number | null;
  /** The same window ending seven days earlier, for a week-over-week read. */
  previousRequests: number;
  previousBytes: number;
}

/** The UTC day, `days` days ago, in the form `http_host_daily.day` stores. */
export function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

interface Accumulator {
  requests: number;
  bytes: number;
  browserRequests: number;
  notModified: number;
  rateLimited: number;
  blocked: number;
  robotsDenied: number;
  capRejected: number;
  errors: number;
  buckets: number[];
  previousRequests: number;
  previousBytes: number;
}

const empty = (): Accumulator => ({
  requests: 0, bytes: 0, browserRequests: 0, notModified: 0, rateLimited: 0, blocked: 0,
  robotsDenied: 0, capRejected: 0, errors: 0, buckets: LATENCY_BUCKET_UPPER_MS.map(() => 0),
  previousRequests: 0, previousBytes: 0,
});

/**
 * p95 from the histogram: the upper bound of the bucket where the running count first reaches 95%
 * of the requests. null means the open top bucket, which is "slower than the last bound".
 */
export function p95FromBuckets(buckets: readonly number[]): number | null {
  const total = buckets.reduce((sum, n) => sum + n, 0);
  if (total === 0) return null;
  const target = total * 0.95;
  let seen = 0;
  for (let i = 0; i < buckets.length; i++) {
    seen += buckets[i] ?? 0;
    if (seen >= target) {
      const upper = LATENCY_BUCKET_UPPER_MS[i];
      return upper === undefined || !Number.isFinite(upper) ? null : upper;
    }
  }
  return null;
}

/**
 * Fold rows into one line per host: the last `days` UTC days, today included, and the `days`
 * before them for the delta, each window exactly `days` long so a steady week reads as steady.
 * Anything older is ignored. Hosts seen only in the older window are kept, because a board that
 * stopped being fetched at all is the change worth noticing.
 */
export function foldOutboundTraffic(rows: readonly HttpHostDailyRow[], days = 7, now: Date = new Date()): HostTraffic[] {
  const boundary = dayKey(now.getTime() - (days - 1) * 86_400_000);
  const oldest = dayKey(now.getTime() - (days * 2 - 1) * 86_400_000);
  const hosts = new Map<string, Accumulator>();
  for (const row of rows) {
    if (row.day < oldest) continue;
    let host = hosts.get(row.host);
    if (!host) {
      host = empty();
      hosts.set(row.host, host);
    }
    if (row.day < boundary) {
      host.previousRequests += row.requests;
      host.previousBytes += row.bytesIn;
      continue;
    }
    host.requests += row.requests;
    host.bytes += row.bytesIn;
    if (row.via === "browser") host.browserRequests += row.requests;
    host.notModified += row.notModified304;
    host.rateLimited += row.rateLimited;
    host.blocked += row.blocked;
    host.robotsDenied += row.robotsDenied;
    host.capRejected += row.capRejected;
    host.errors += row.client4xx + row.server5xx + row.timeouts + row.networkErrors;
    row.latencyBuckets.forEach((count, i) => { host.buckets[i] = (host.buckets[i] ?? 0) + count; });
  }
  return [...hosts.entries()]
    .map(([host, a]) => ({
      host,
      requests: a.requests,
      bytes: a.bytes,
      browserShare: a.requests ? a.browserRequests / a.requests : 0,
      notModifiedRatio: a.requests ? a.notModified / a.requests : 0,
      rateLimitedRatio: a.requests ? a.rateLimited / a.requests : 0,
      blocked: a.blocked,
      robotsDenied: a.robotsDenied,
      capRejected: a.capRejected,
      errors: a.errors,
      p95Ms: p95FromBuckets(a.buckets),
      previousRequests: a.previousRequests,
      previousBytes: a.previousBytes,
    }))
    .sort((a, b) => b.requests - a.requests || b.previousRequests - a.previousRequests || a.host.localeCompare(b.host));
}

/** A host is worth a warn tone when it is throttling us, or refusing us outright. */
export function hostNeedsAttention(row: HostTraffic): boolean {
  return row.rateLimitedRatio > 0.01 || row.blocked > 0;
}
