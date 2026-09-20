import { and, desc, eq, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import {
  cvBuildStepsSignature,
  cvDrafts,
  cvLibraries,
  cvVersions,
  latestLibraryReviews,
  libraryReviewsSignature,
  listCvBuildSteps,
  tasks,
} from "@christopher/db";
import type { CvBuildFailure, CvBuildStepView, CvLibrary } from "@christopher/core";
import { libraryEntryInputHash } from "@christopher/core/library-review";
import { cvWorkVersion, normaliseCvStepsSignature } from "@/lib/cv-build-state";
import type { LibraryEvidence } from "@/lib/cv-library-evidence";
import {
  libraryEvidence,
  type LibraryReviewRun,
  type StoredLibraryReview,
} from "@/lib/cv-library-reviews";
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

/**
 * The columns a build's own account of itself lives in, which arrived with the worker's last two
 * migrations (`progress_at` in 0025, `build_checkpoint` and `failure` in 0027).
 *
 * The interface deploys separately from the worker that migrates, and `select *` over a column
 * that is not there yet is not a degraded page but a 500 on every CV page and every poll. Probed
 * once and remembered — but only when they are all present, so the release that is briefly ahead
 * of its migration recovers by itself the moment the worker catches up, without a redeploy.
 */
const BUILD_COLUMNS = ["progress_at", "build_checkpoint", "failure"] as const;
let buildColumnsPresent: Promise<boolean> | null = null;

function cvBuildColumnsPresent(): Promise<boolean> {
  buildColumnsPresent ??= db()
    .execute<{ n: number }>(
      sql`select count(*)::int as n from information_schema.columns
          where table_schema = 'public' and table_name = 'cv_drafts'
            and column_name in (${sql.join(BUILD_COLUMNS.map((column) => sql`${column}`), sql`, `)})`,
    )
    .then((result) => {
      const present = (result.rows[0]?.n ?? 0) === BUILD_COLUMNS.length;
      if (!present) buildColumnsPresent = null;
      return present;
    })
    .catch(() => {
      buildColumnsPresent = null;
      return false;
    });
  return buildColumnsPresent;
}

/** Every column of `cv_drafts` that predates the build ledger, for a database without the rest. */
const settledCvDraftColumns = {
  id: cvDrafts.id,
  userId: cvDrafts.userId,
  jobId: cvDrafts.jobId,
  jobTitle: cvDrafts.jobTitle,
  companyName: cvDrafts.companyName,
  jobDescription: cvDrafts.jobDescription,
  jobSource: cvDrafts.jobSource,
  assessment: cvDrafts.assessment,
  finalisedAt: cvDrafts.finalisedAt,
  libraryVersion: cvDrafts.libraryVersion,
  librarySnapshot: cvDrafts.librarySnapshot,
  model: cvDrafts.model,
  status: cvDrafts.status,
  buildStage: cvDrafts.buildStage,
  content: cvDrafts.content,
  error: cvDrafts.error,
  revision: cvDrafts.revision,
  parentId: cvDrafts.parentId,
  archivedAt: cvDrafts.archivedAt,
  createdAt: cvDrafts.createdAt,
};

/** One account's draft by id, or null when it belongs to someone else. */
export async function getOwnCvDraft(userId: string, id: string): Promise<typeof cvDrafts.$inferSelect | null> {
  const owned = and(eq(cvDrafts.id, id), eq(cvDrafts.userId, userId));
  if (await cvBuildColumnsPresent()) {
    const [draft] = await db().select().from(cvDrafts).where(owned).limit(1);
    return draft ?? null;
  }
  const [draft] = await db().select(settledCvDraftColumns).from(cvDrafts).where(owned).limit(1);
  // A build that has not been recorded yet reads as one that recorded nothing.
  return draft ? { ...draft, progressAt: null, buildCheckpoint: null, failure: null } : null;
}

/**
 * What one account's poll needs of its draft: its state, its staleness and its last failure. The
 * same migration guard as `getOwnCvDraft`, because `/api/work-status` is asked for this every ten
 * seconds by every open CV page.
 */
export async function getOwnCvWorkRow(userId: string, id: string) {
  const owned = and(eq(cvDrafts.id, id), eq(cvDrafts.userId, userId));
  const settled = {
    id: cvDrafts.id,
    status: cvDrafts.status,
    buildStage: cvDrafts.buildStage,
    createdAt: cvDrafts.createdAt,
  };
  if (await cvBuildColumnsPresent()) {
    const [row] = await db()
      .select({ ...settled, progressAt: cvDrafts.progressAt, failure: cvDrafts.failure })
      .from(cvDrafts)
      .where(owned)
      .limit(1);
    return row ?? null;
  }
  const [row] = await db().select(settled).from(cvDrafts).where(owned).limit(1);
  return row ? { ...row, progressAt: null, failure: null as CvBuildFailure | null } : null;
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
 * The token the poll compares: the draft's own state and staleness, the failure it recorded, and
 * the signature of its ledger — so a motion opening or closing refreshes the page as surely as a
 * stage change does.
 *
 * This is the poll's route to it, which has only an id and so asks the database for the ledger's
 * signature. The page has the rows themselves and passes `cvStepsSignature` of them to
 * `cvWorkVersion`; both are reduced to the same canonical moment, so the two agree.
 */
export async function cvWorkVersionFor(
  draft: { id: string; status: string; buildStage: string | null; progressAt: Date | null; createdAt: Date; failure?: CvBuildFailure | null },
  now: Date = new Date(),
): Promise<string> {
  let signature = "";
  try {
    signature = normaliseCvStepsSignature(await cvBuildStepsSignature(db(), draft.id));
  } catch {
    // No ledger yet: the version still moves on the draft's own state and the minute tick.
  }
  return cvWorkVersion(draft, now, signature);
}

/**
 * The account's latest saved Library: the version the editor writes over and the content it opens.
 */
export async function getOwnCvLibrary(userId: string) {
  const [library] = await db()
    .select({ version: cvLibraries.version, content: cvLibraries.content, createdAt: cvLibraries.createdAt })
    .from(cvLibraries)
    .where(eq(cvLibraries.userId, userId))
    .orderBy(desc(cvLibraries.version))
    .limit(1);
  return library ?? null;
}

/** The account's saved versions, newest first. A history is read, not scrolled: twenty is plenty. */
export async function listLibraryVersions(userId: string, limit = 20) {
  return db()
    .select({ version: cvLibraries.version, createdAt: cvLibraries.createdAt })
    .from(cvLibraries)
    .where(eq(cvLibraries.userId, userId))
    .orderBy(desc(cvLibraries.version))
    .limit(Math.max(1, Math.min(100, limit)));
}

/** Two of this account's versions by number, for a diff. Never read without the account. */
export async function getLibraryVersionContents(userId: string, versions: number[]): Promise<Map<number, CvLibrary>> {
  const wanted = [...new Set(versions.filter(version => Number.isInteger(version)))];
  if (!wanted.length) return new Map();
  const rows = await db()
    .select({ version: cvLibraries.version, content: cvLibraries.content })
    .from(cvLibraries)
    .where(and(eq(cvLibraries.userId, userId), inArray(cvLibraries.version, wanted)));
  return new Map(rows.map(row => [row.version, row.content]));
}

/** Whether a version number names one of this account's own saved libraries. */
export async function ownsLibraryVersion(userId: string, version: number): Promise<boolean> {
  if (!Number.isInteger(version) || version < 1) return false;
  const [row] = await db()
    .select({ version: cvLibraries.version })
    .from(cvLibraries)
    .where(and(eq(cvLibraries.userId, userId), eq(cvLibraries.version, version)))
    .limit(1);
  return !!row;
}

/**
 * Whether an evidence pass is in flight for this account, and the sentence that refused the last
 * one.
 *
 * The dedupe key is the account, so there is one row worth reading: the newest. A pass the budget
 * refused finishes rather than fails — retrying work the month cannot pay for would fill Health
 * with nothing — and records the refusal in its result, which is the sentence the Library shows
 * instead of "Evaluating…". It is the worker's own wording, taken as it was written.
 */
async function libraryReviewRun(userId: string): Promise<LibraryReviewRun> {
  const [newest] = await db()
    .select({ status: tasks.status, result: tasks.result })
    .from(tasks)
    .where(and(eq(tasks.type, "review_library"), sql`${tasks.payload}->>'userId' = ${userId}`))
    .orderBy(desc(tasks.createdAt))
    .limit(1);
  if (!newest) return { pending: false, refusal: null };
  if (newest.status === "queued" || newest.status === "running") return { pending: true, refusal: null };
  const result = (newest.result ?? null) as { skipped?: unknown; message?: unknown } | null;
  const refused = result?.skipped === "budget" && typeof result.message === "string" ? result.message : null;
  return { pending: false, refusal: refused };
}

/**
 * The stored reviews that still describe the library as it is saved now.
 *
 * `cv_library_reviews` arrived with the worker's migration and the interface deploys separately,
 * so a release serving ahead of it reads as "nothing reviewed yet" — every entry falls back to the
 * baseline computed from the person's own tags — rather than an error page over the Library.
 */
async function readLibraryReviews(userId: string, content: CvLibrary): Promise<Map<string, StoredLibraryReview>> {
  const wanted = content.entries.map(entry => ({
    entryId: entry.id,
    inputHash: libraryEntryInputHash(entry, content.employment?.find(job => job.id === entry.employmentId) ?? null),
  }));
  try {
    const rows = await latestLibraryReviews(db(), userId, wanted);
    return new Map([...rows].map(([entryId, row]) => [entryId, { entryId, source: row.source, review: row.review }]));
  } catch {
    return new Map();
  }
}

/** Everything the Library page shows about how well it is evidenced. One call, one account. */
export async function getLibraryEvidence(
  userId: string,
  library: { content: CvLibrary } | null,
): Promise<LibraryEvidence> {
  if (!library) return libraryEvidence(null, new Map());
  const [stored, run] = await Promise.all([readLibraryReviews(userId, library.content), libraryReviewRun(userId)]);
  return libraryEvidence(library.content, stored, run);
}

/**
 * The poll token for one version's reviews: it moves when a review is added, replaced, rescored or
 * reclassified, and not otherwise. Empty for a database that has not been migrated for them yet,
 * which the poller reads as "nothing has landed" rather than as a failure.
 */
export async function libraryReviewSignature(userId: string, version: number): Promise<string> {
  try {
    return await libraryReviewsSignature(db(), userId, version);
  } catch {
    return "";
  }
}
