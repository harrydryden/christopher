import { routeUser } from '@/lib/route-auth';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  const auth = await routeUser();
  if (!auth.ok) return auth.response;
  const body = await request.text();
  if (body.length > 1000) return new Response(null, { status: 413 });
  try {
    const data = JSON.parse(body);
    if (typeof data.path !== 'string' || !/^\/[a-z0-9/:-]*$/i.test(data.path) || !Number.isFinite(data.durationMs) || data.durationMs < 0 || data.durationMs > 300000) return new Response(null, { status: 400 });
    console.info(JSON.stringify({ event: 'page_navigation', path: data.path, durationMs: Math.round(data.durationMs), region: process.env.VERCEL_REGION ?? 'local' }));
    return new Response(null, { status: 204 });
  } catch { return new Response(null, { status: 400 }); }
}
