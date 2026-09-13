import { desc, isNull, isNotNull, sql } from "drizzle-orm";
import { cvDrafts } from "@christopher/db";
import { db, type Db } from "@/lib/db";
import { pageNumber } from "@/components/Pagination";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
const PAGE_SIZE = 50;
async function readCvDraftPage(
  tx: Transaction,
  archived: boolean,
  requestedPage?: string,
) {
  const condition = archived
    ? isNotNull(cvDrafts.archivedAt)
    : isNull(cvDrafts.archivedAt);
  const [count] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(cvDrafts)
    .where(condition);
  const total = count?.n ?? 0;
  const page = Math.min(
    pageNumber(requestedPage),
    Math.max(1, Math.ceil(total / PAGE_SIZE)),
  );
  const rows = await tx
    .select({
      id: cvDrafts.id,
      jobTitle: cvDrafts.jobTitle,
      company: cvDrafts.companyName,
      status: cvDrafts.status,
      revision: cvDrafts.revision,
      createdAt: cvDrafts.createdAt,
    })
    .from(cvDrafts)
    .where(condition)
    .orderBy(desc(cvDrafts.createdAt), desc(cvDrafts.id))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);
  return { rows, total, page };
}

/** Counts and both tables share a snapshot even when a build completes concurrently. */
export async function listCvDraftPages(
  savedPage?: string,
  archivedPage?: string,
) {
  return db().transaction(
    async (tx) => {
      const saved = await readCvDraftPage(tx, false, savedPage);
      const archived = await readCvDraftPage(tx, true, archivedPage);
      return { saved, archived };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export async function listCvDraftPage(
  archived: boolean,
  requestedPage?: string,
) {
  return db().transaction(
    (tx) => readCvDraftPage(tx, archived, requestedPage),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
