import { getCompanyWorkStatus } from "@/lib/work-status";
import { eq } from 'drizzle-orm';
import { cvDrafts } from '@christopher/db/schema';
import { db } from '@/lib/db';
import { requireSession } from '@/lib/auth';
import { zUuid } from '@/lib/validation';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  await requireSession();
  const id = new URL(request.url).searchParams.get('cv');
  if (id) {
    if (!zUuid().safeParse(id).success) return new Response('Invalid ID', { status: 400 });
    const [row] = await db().select({ status: cvDrafts.status }).from(cvDrafts).where(eq(cvDrafts.id, id));
    return Response.json({ active: row?.status === 'queued' || row?.status === 'generating', version: row?.status ?? 'missing' }, { headers: { 'cache-control': 'no-store' } });
  }
  return Response.json(await getCompanyWorkStatus(), { headers: { 'cache-control': 'no-store' } });
}
