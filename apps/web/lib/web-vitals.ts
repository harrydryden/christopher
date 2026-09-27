/**
 * Real-user Core Web Vitals: what the browser beacon may carry, how a value becomes a histogram
 * bucket, and how a histogram becomes a p75. Pure, so the beacon, the route and Operations share one
 * definition and each is testable without a browser or a database.
 *
 * Privacy is a shape rule, enforced here: a beacon carries exactly the keys below and nothing else,
 * no account, session, email, address, query string or full URL. The route stores only
 * `(day, route, metric, bucket, count)`: a histogram, never an event.
 */

export const VITAL_METRICS = ["LCP", "INP", "CLS", "TTFB", "FCP"] as const;
export type VitalMetric = (typeof VITAL_METRICS)[number];

export const VITAL_RATINGS = ["good", "needs-improvement", "poor"] as const;
export const VITAL_NAV_TYPES = ["navigate", "reload", "back-forward", "back-forward-cache", "prerender", "restore", "soft-navigation"] as const;
export const VITAL_DEVICE_CLASSES = ["low", "high"] as const;
export const VITAL_EFFECTIVE_TYPES = ["slow-2g", "2g", "3g", "4g", "unknown"] as const;

/** One metric's final value for one page load, as the beacon sends it. */
export interface VitalReport {
  route: string;
  metric: VitalMetric;
  value: number;
  rating: (typeof VITAL_RATINGS)[number];
  navType: (typeof VITAL_NAV_TYPES)[number];
  deviceClass: (typeof VITAL_DEVICE_CLASSES)[number];
  effectiveType: (typeof VITAL_EFFECTIVE_TYPES)[number];
}

const REPORT_KEYS = ["route", "metric", "value", "rating", "navType", "deviceClass", "effectiveType"] as const;

/** Share of page loads that report at all, decided once per load. */
export const VITALS_SAMPLE_RATE = 0.25;
/** One beacon carries at most one report per metric. */
export const VITALS_MAX_REPORTS = VITAL_METRICS.length;
/** Bytes a beacon may be; five reports fit in well under half of it. */
export const VITALS_MAX_BYTES = 2_000;
/** How long rows are kept; the monitor task prunes older days. */
export const VITALS_RETENTION_DAYS = 90;

/**
 * A path as a route: every id-shaped segment becomes `:id`, so `/companies/<uuid>` and
 * `/cv/<uuid>` are one route each, and nothing that names a record leaves the browser.
 */
export function vitalRoute(pathname: string): string {
  const path = pathname.split(/[?#]/)[0] || "/";
  return path
    .split("/")
    .map((segment) => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) || /^\d+$/.test(segment) || /^[A-Za-z0-9_-]{20,}$/.test(segment) ? ":id" : segment))
    .join("/")
    .slice(0, 100) || "/";
}

const ROUTE = /^\/[a-z0-9/:_-]{0,99}$/i;

/** The ceiling each metric's value may take: ten minutes of milliseconds, or a layout shift of 100. */
function maxValue(metric: VitalMetric): number {
  return metric === "CLS" ? 100 : 600_000;
}

const oneOf = <T extends readonly string[]>(values: T, value: unknown): value is T[number] => typeof value === "string" && (values as readonly string[]).includes(value);

/** One report, or null when it is not exactly the shape above: an extra key, a missing one, a bad value. */
export function readVitalReport(value: unknown): VitalReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== REPORT_KEYS.length || !REPORT_KEYS.every((key) => Object.hasOwn(record, key))) return null;
  const { route, metric, value: reading, rating, navType, deviceClass, effectiveType } = record;
  if (typeof route !== "string" || !ROUTE.test(route) || route !== vitalRoute(route)) return null;
  if (!oneOf(VITAL_METRICS, metric)) return null;
  if (typeof reading !== "number" || !Number.isFinite(reading) || reading < 0 || reading > maxValue(metric)) return null;
  if (!oneOf(VITAL_RATINGS, rating) || !oneOf(VITAL_NAV_TYPES, navType) || !oneOf(VITAL_DEVICE_CLASSES, deviceClass) || !oneOf(VITAL_EFFECTIVE_TYPES, effectiveType)) return null;
  return { route, metric, value: reading, rating, navType, deviceClass, effectiveType };
}

/** A beacon's body: a JSON array of one to five reports, one per metric at most, or null. */
export function readVitalsBeacon(body: string): VitalReport[] | null {
  if (body.length > VITALS_MAX_BYTES) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > VITALS_MAX_REPORTS) return null;
  const reports = parsed.map(readVitalReport);
  if (reports.some((report) => report === null)) return null;
  const valid = reports as VitalReport[];
  if (new Set(valid.map((report) => report.metric)).size !== valid.length) return null;
  return valid;
}

/**
 * Log-scaled buckets, eight to a doubling, so a bucket is about 9 % wide and a p75 read from it is
 * within about 4.5 % of the true value. Milliseconds for the timings; CLS is scaled by a thousand
 * first. Bucket 0 holds zero (and anything under one unit).
 */
const PER_DOUBLING = 8;
const scale = (metric: VitalMetric) => (metric === "CLS" ? 1_000 : 1);

export function vitalBucket(metric: VitalMetric, value: number): number {
  const scaled = value * scale(metric);
  if (!(scaled >= 1)) return 0;
  return Math.min(32_767, Math.floor(Math.log2(scaled) * PER_DOUBLING) + 1);
}

/** The value a bucket stands for: its geometric middle, back in the metric's own unit. */
export function vitalBucketValue(metric: VitalMetric, bucket: number): number {
  if (bucket <= 0) return 0;
  return 2 ** ((bucket - 0.5) / PER_DOUBLING) / scale(metric);
}

/**
 * The 75th percentile of a histogram: the bucket in which the running count first reaches three
 * quarters of the total. Null for an empty histogram.
 */
export function histogramP75(metric: VitalMetric, rows: Array<{ bucket: number; count: number }>): number | null {
  const sorted = [...rows].filter((row) => row.count > 0).sort((a, b) => a.bucket - b.bucket);
  const total = sorted.reduce((sum, row) => sum + row.count, 0);
  if (total === 0) return null;
  const target = Math.ceil(total * 0.75);
  let running = 0;
  for (const row of sorted) {
    running += row.count;
    if (running >= target) return vitalBucketValue(metric, row.bucket);
  }
  return vitalBucketValue(metric, sorted.at(-1)!.bucket);
}

/** The "good" and "poor" boundaries Google publishes for each metric, in its own unit. */
export const VITAL_THRESHOLDS: Record<VitalMetric, { good: number; poor: number }> = {
  LCP: { good: 2_500, poor: 4_000 },
  INP: { good: 200, poor: 500 },
  CLS: { good: 0.1, poor: 0.25 },
  TTFB: { good: 800, poor: 1_800 },
  FCP: { good: 1_800, poor: 3_000 },
};

export function vitalRating(metric: VitalMetric, value: number): (typeof VITAL_RATINGS)[number] {
  const { good, poor } = VITAL_THRESHOLDS[metric];
  return value <= good ? "good" : value <= poor ? "needs-improvement" : "poor";
}

/** "2.4 s", "180 ms", "0.08". */
export function formatVital(metric: VitalMetric, value: number): string {
  if (metric === "CLS") return value.toFixed(2);
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)} s` : `${Math.round(value)} ms`;
}
