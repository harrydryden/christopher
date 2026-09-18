import { and, desc, eq, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import { cvBuildStepsSignature, cvDrafts, cvVersions, listCvBuildSteps, tasks } from "@christopher/db";
import type { CvBuildFailure, CvBuildStepView } from "@christopher/core";
import { cvWorkVersion } from "@/lib/cv-build-state";
import { db, type Db } from "@/lib/db";
import { pageNumber } from "@/components/Pagination";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
const PAGE_SIZE = 50;
async function readCvDraftPage(
  tx: Transaction,
  userId: string,
  archived: boolean,
  requestedPage?: string,
) {
  const condition = and(eq(cvDrafts.userId, userId), archived
    ? isNotNull(cvDrafts.archivedAt)
    : isNull(cvDrafts.archivedAt));
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
  userId: string,
  savedPage?: string,
  archivedPage?: string,
) {
  return db().transaction(
    async (tx) => {
      const saved = await readCvDraftPage(tx, userId, false, savedPage);
      const archived = await readCvDraftPage(tx, userId, true, archivedPage);
      return { saved, archived };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export async function listCvDraftPage(
  userId: string,
  archived: boolean,
  requestedPage?: string,
) {
  return db().transaction(
    (tx) => readCvDraftPage(tx, userId, archived, requestedPage),
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

/** One account's draft by id, or null when it belongs to someone else. */
export async function getOwnCvDraft(userId: string, id: string) {
  const [draft] = await db().select().from(cvDrafts).where(and(eq(cvDrafts.id, id), eq(cvDrafts.userId, userId))).limit(1);
  return draft ?? null;
}

/**
 * The queue row behind one account's build, by the dedupe key its enqueue used. It carries the
 * only evidence that a draft stuck on "generating" has anything working on it: the attempt number,
 * whether it is claimed, and the error a handed-back attempt left. Reached through the draft, so
 * it is never read without the account that owns it.
 *
 * The dedupe index covers queued and running rows only, so a role can accumulate finished ones;
 * the newest is the attempt this page is about.
 */
export async function getOwnCvBuildTask(userId: string, draftId: string) {
  const [row] = await db()
    .select({
      status: tasks.status,
      attempts: tasks.attempts,
      maxAttempts: tasks.maxAttempts,
      error: tasks.error,
      startedAt: tasks.startedAt,
    })
    .from(tasks)
    .innerJoin(cvDrafts, eq(cvDrafts.id, draftId))
    .where(and(eq(tasks.dedupeKey, `generate_cv:${draftId}`), eq(cvDrafts.userId, userId)))
    .orderBy(desc(tasks.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * The motions of one account's build, for the narrative under the milestone strip. Read through
 * the owner: `cv_build_steps` carries a `user_id` and is never read without one.
 *
 * The ledger arrives with the worker's migration, and the interface deploys separately, so a
 * release serving before it reads as "nothing recorded" rather than an error page over a CV.
 */
export async function getOwnCvBuildSteps(userId: string, draftId: string): Promise<CvBuildStepView[]> {
  try {
    return await listCvBuildSteps(db(), userId, draftId);
  } catch {
    return [];
  }
}

/**
 * The token the CV page's poll compares, assembled in one place so `/api/work-status` and the page
 * cannot disagree about it: the draft's own state and staleness, the failure it recorded, and the
 * signature of its ledger — so a motion opening or closing refreshes the page as surely as a stage
 * change does.
 */
export async function cvWorkVersionFor(
  draft: { id: string; status: string; buildStage: string | null; progressAt: Date | null; createdAt: Date; failure?: CvBuildFailure | null },
  now: Date = new Date(),
): Promise<string> {
  let signature = "";
  try {
    signature = await cvBuildStepsSignature(db(), draft.id);
  } catch {
    // No ledger yet: the version still moves on the draft's own state and the minute tick.
  }
  return cvWorkVersion(draft, now, signature);
}
