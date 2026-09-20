import { getAccountWorkStatus } from "@/lib/work-status";
import { routeUser } from '@/lib/route-auth';
import { zUuid } from '@/lib/validation';
import { cvWorkVersionFor, getOwnCvWorkRow } from '@/lib/queries/cv';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  // A correctly signed cookie can still name an expired or revoked database session. Middleware
  // cannot know that without a database read, so handle it here as an authentication failure
  // rather than allowing requireUser's server-action error to become an API 500.
  const auth = await routeUser();
  if (!auth.ok) return auth.response;
  const user = auth.user;
  const id = new URL(request.url).searchParams.get('cv');
  if (id) {
    if (!zUuid().safeParse(id).success) return Response.json({ ok: false, error: 'Invalid ID' }, { status: 400 });
    const row = await getOwnCvWorkRow(user.id, id);
    // The version carries how long the build has been still, which motion of it is open and what
    // it last failed at, as well as what it is doing — so the page's "last progress N minutes ago",
    // its narrative and its "running 46 s" all keep counting without a second timer on the client.
    return Response.json({ active: row?.status === 'queued' || row?.status === 'generating', version: row ? await cvWorkVersionFor(row) : 'missing' }, { headers: { 'cache-control': 'no-store' } });
  }
  // No `cv` asked for: everything this account is waiting on — its companies' scans and discovery,
  // and any CV of its own still queued or building, which is what the applications table watches.
  return Response.json(await getAccountWorkStatus(user.id), { headers: { 'cache-control': 'no-store' } });
}
