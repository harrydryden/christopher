import { getAccountWorkStatus, getCompanyWorkStatus, getCvWorkStatus } from "@/lib/work-status";
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
  const params = new URL(request.url).searchParams;
  const id = params.get('cv');
  if (id) {
    if (!zUuid().safeParse(id).success) return Response.json({ ok: false, error: 'Invalid ID' }, { status: 400 });
    const row = await getOwnCvWorkRow(user.id, id);
    // The version carries how long the build has been still, which motion of it is open and what
    // it last failed at, as well as what it is doing — so the page's "last progress N minutes ago",
    // its narrative and its "running 46 s" all keep counting without a second timer on the client.
    return Response.json({ active: row?.status === 'queued' || row?.status === 'generating', version: row ? await cvWorkVersionFor(row) : 'missing' }, { headers: { 'cache-control': 'no-store' } });
  }
  // A page that renders one half's version asks for that half, so the version it compares is the
  // one it rendered: the roles and companies pages watch their companies' work, and a page listing
  // CVs watches only builds.
  const scope = params.get('scope');
  if (scope === 'company') return Response.json(await getCompanyWorkStatus(user.id), { headers: { 'cache-control': 'no-store' } });
  if (scope === 'cv') return Response.json(await getCvWorkStatus(user.id), { headers: { 'cache-control': 'no-store' } });
  if (scope !== null) return Response.json({ ok: false, error: 'Invalid scope' }, { status: 400 });
  // Nothing narrower asked for: everything this account is waiting on — its companies' scans and
  // discovery, and any CV of its own still queued or building.
  return Response.json(await getAccountWorkStatus(user.id), { headers: { 'cache-control': 'no-store' } });
}
