import { requireSession } from '@/lib/auth';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  await requireSession();
  const body = await request.text();
  if (body.length > 1000) return new Response(null, { status: 413 });
  try {
    const data = JSON.parse(body);
    if (typeof data.path !== 'string' || !/^\/[a-z0-9/:-]*$/i.test(data.path) || !Number.isFinite(data.durationMs) || data.durationMs < 0 || data.durationMs > 300000) return new Response(null, { status: 400 });
    console.info(JSON.stringify({ event: 'page_navigation', path: data.path, durationMs: Math.round(data.durationMs), region: process.env.VERCEL_REGION ?? 'local' }));
    return new Response(null, { status: 204 });
  } catch { return new Response(null, { status: 400 }); }
}
export async function GET() {
  await requireSession();
  const started = performance.now();
  await db().execute(sql`select 1`);
  return Response.json({ region: process.env.VERCEL_REGION ?? 'local', databaseRoundTripMs: Math.round(performance.now() - started) }, { headers: { 'cache-control': 'no-store' } });
}
