import { desc, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import { cvDrafts, cvVersions } from "@christopher/db";
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
  const versions = await dailyCvVersions(tx, rows.map(row => row.id));
  return { rows: rows.map(row => ({ ...row, dailyVersion: versions.get(row.id) ?? Math.max(1, row.revision) })), total, page };
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

/** The deployment may precede the worker's migration; keep existing CVs readable. */
export async function dailyCvVersions(database: Pick<Db, "execute" | "select">, ids: string[]) {
  if (!ids.length) return new Map<string, number>();
  const available = await database.execute<{ present: boolean }>(sql`select to_regclass('public.cv_versions') is not null as present`);
  if (!available.rows[0]?.present) return new Map<string, number>();
  const rows = await database.select({ id: cvVersions.cvId, version: cvVersions.version })
    .from(cvVersions).where(inArray(cvVersions.cvId, ids));
  return new Map(rows.map(row => [row.id, row.version]));
}
