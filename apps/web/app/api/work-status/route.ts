import { getCompanyWorkStatus } from "@/lib/work-status";
import { and, eq } from 'drizzle-orm';
import { cvDrafts } from '@christopher/db/schema';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { zUuid } from '@/lib/validation';
import { cvWorkVersionFor } from '@/lib/queries/cv';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const user = await requireUser();
  const id = new URL(request.url).searchParams.get('cv');
  if (id) {
    if (!zUuid().safeParse(id).success) return Response.json({ ok: false, error: 'Invalid ID' }, { status: 400 });
    const [row] = await db().select({ id: cvDrafts.id, status: cvDrafts.status, buildStage: cvDrafts.buildStage, progressAt: cvDrafts.progressAt, createdAt: cvDrafts.createdAt, failure: cvDrafts.failure }).from(cvDrafts).where(and(eq(cvDrafts.id, id), eq(cvDrafts.userId, user.id)));
    // The version carries how long the build has been still, which motion of it is open and what
    // it last failed at, as well as what it is doing — so the page's "last progress N minutes ago",
    // its narrative and its "running 46 s" all keep counting without a second timer on the client.
    return Response.json({ active: row?.status === 'queued' || row?.status === 'generating', version: row ? await cvWorkVersionFor(row) : 'missing' }, { headers: { 'cache-control': 'no-store' } });
  }
  return Response.json(await getCompanyWorkStatus(user.id), { headers: { 'cache-control': 'no-store' } });
}
