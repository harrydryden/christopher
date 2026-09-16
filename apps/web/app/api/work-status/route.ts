import { getCompanyWorkStatus } from "@/lib/work-status";
import { and, eq } from 'drizzle-orm';
import { cvDrafts } from '@christopher/db/schema';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { zUuid } from '@/lib/validation';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const user = await requireUser();
  const id = new URL(request.url).searchParams.get('cv');
  if (id) {
    if (!zUuid().safeParse(id).success) return new Response('Invalid ID', { status: 400 });
    const [row] = await db().select({ status: cvDrafts.status, stage: cvDrafts.buildStage }).from(cvDrafts).where(and(eq(cvDrafts.id, id), eq(cvDrafts.userId, user.id)));
    return Response.json({ active: row?.status === 'queued' || row?.status === 'generating', version: row ? `${row.status}:${row.stage ?? ''}` : 'missing' }, { headers: { 'cache-control': 'no-store' } });
  }
  return Response.json(await getCompanyWorkStatus(user.id), { headers: { 'cache-control': 'no-store' } });
}
