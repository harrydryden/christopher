import { cookies } from 'next/headers';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { sessionCookieValue, sessionSecret, verifySessionCookieValue } from '@/lib/session';
import { readVitalsBeacon, vitalBucket, VITALS_MAX_BYTES } from '@/lib/web-vitals';
import { readCapped } from '@/lib/route-request';
export const dynamic = 'force-dynamic';

/**
 * One sampled page load's Core Web Vitals, added to the day's histograms. It reads no account's
 * data and stores none: a validly signed session cookie is enough (the check middleware makes,
 * repeated here, without the session row that would cost a round trip), and what is written is a
 * count against `(day, route, metric, bucket)`.
 *
 * The body must be exactly the shape `lib/web-vitals.ts` defines, naming one of the app's own routes
 * (`VITAL_ROUTES`); any other key or route is refused with 400,
 * which is how the rule "no identifiers" is enforced rather than hoped for. A write that fails still
 * answers 204: the beacon has nobody to report to, and a lost sample is not worth a retry.
 */
export async function POST(request: Request) {
  const secret = sessionSecret();
  if (!secret || !(await verifySessionCookieValue(sessionCookieValue(await cookies()), secret))) {
    return Response.json({ ok: false, error: 'Please sign in again.' }, { status: 401, headers: { 'cache-control': 'private, no-store' } });
  }
  // Refused on its declared size before a byte is read, and again on what actually arrived, since
  // a chunked body declares none.
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > VITALS_MAX_BYTES) return new Response(null, { status: 413 });
  const received = await readCapped(request, VITALS_MAX_BYTES);
  if (!received.ok && received.reason === "too_large") return new Response(null, { status: 413 });
  // An empty beacon reads as an empty body, which the shape check refuses.
  const body = received.ok ? new TextDecoder().decode(received.bytes) : received.reason === "missing" ? "" : null;
  const reports = body === null ? null : readVitalsBeacon(body);
  if (!reports) return new Response(null, { status: 400 });
  // One row per bucket, so a single statement never touches the same key twice.
  const counts = new Map<string, { route: string; metric: string; bucket: number; count: number }>();
  for (const report of reports) {
    const bucket = vitalBucket(report.metric, report.value);
    const key = `${report.route}\u0000${report.metric}\u0000${bucket}`;
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { route: report.route, metric: report.metric, bucket, count: 1 });
  }
  try {
    const rows = [...counts.values()].map((row) => sql`((now() at time zone 'utc')::date, ${row.route}, ${row.metric}, ${row.bucket}::smallint, ${row.count}::int)`);
    await db().execute(sql`insert into web_vitals (day, route, metric, bucket, count) values ${sql.join(rows, sql`, `)}
      on conflict (day, route, metric, bucket) do update set count = web_vitals.count + excluded.count`);
  } catch (error) {
    console.warn(JSON.stringify({ event: 'web_vitals_write_failed', error: error instanceof Error ? error.message : 'unknown' }));
  }
  return new Response(null, { status: 204 });
}
