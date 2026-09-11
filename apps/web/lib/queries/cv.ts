import { desc, isNull, isNotNull, sql } from "drizzle-orm";
import { cvDrafts } from "@christopher/db";
import { db } from "@/lib/db";
import { pageNumber } from "@/components/Pagination";

/** Bounded lists retain access to every revision, including the archive. */
export async function listCvDraftPage(archived: boolean, requestedPage?: string) {
  const condition = archived ? isNotNull(cvDrafts.archivedAt) : isNull(cvDrafts.archivedAt);
  const [count] = await db().select({ n: sql<number>`count(*)::int` }).from(cvDrafts).where(condition);
  const total = count?.n ?? 0;
  const page = Math.min(pageNumber(requestedPage), Math.max(1, Math.ceil(total / 50)));
  const rows = await db().select({ id: cvDrafts.id, jobTitle: cvDrafts.jobTitle, company: cvDrafts.companyName, status: cvDrafts.status, revision: cvDrafts.revision })
    .from(cvDrafts).where(condition).orderBy(desc(cvDrafts.createdAt), desc(cvDrafts.id)).limit(50).offset((page - 1) * 50);
  return { rows, total, page };
}
