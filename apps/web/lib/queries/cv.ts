import { and, desc, eq, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import {
  cvBuildMotionStats,
  cvDrafts,
  cvLibraries,
  cvVersions,
  latestLibraryReviews,
  libraryReviewsSignature,
  listCvBuildSteps,
  tasks,
} from "@ava/db";
import type { CvBuildCheckpoint, CvBuildFailure, CvBuildStepView, CvLibrary } from "@ava/core";
import { libraryEntryInputHash, normaliseLibraryReview } from "@ava/core/library-review";
import type { CvBuildTask } from "@/lib/cv-build-state";
import type { CvJournalStep } from "@/lib/cv-build-journal";
import { CV_MEDIAN_MIN_RUNS, type CvMotionMedians } from "@/lib/cv-build-narrative";
import type { CvProgressRows } from "@/lib/cv-progress";
import { getWorkerHeartbeat, readHeartbeat } from "@/lib/queries/health";
import { deriveWorkerStatus } from "@/lib/worker-status";
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
const BUILD_COLUMNS = ["progress_at", "build_checkpoint", "failure", "gap_quiz"] as const;
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
  return draft ? { ...draft, progressAt: null, buildCheckpoint: null, failure: null, gapQuiz: null } : null;
}

/** The raw row `readCvProgress` reads, before it is shaped. */
interface CvProgressRow extends Record<string, unknown> {
  status: CvProgressRows["draft"]["status"];
  buildStage: string | null;
  error: string | null;
  createdAt: Date | string;
  progressAt: Date | string | null;
  failure: CvBuildFailure | null;
  buildCheckpoint: CvBuildCheckpoint | null;
  taskStatus: CvBuildTask["status"] | null;
  attempts: number | null;
  maxAttempts: number | null;
  taskError: string | null;
  taskStartedAt: Date | string | null;
  anyTaskActive: boolean;
  heartbeat: unknown;
  n: number | null;
  running: number | null;
  last: string | null;
  steps: Array<Record<string, unknown>> | null;
}

const asDate = (value: Date | string | null | undefined): Date | null => (value === null || value === undefined ? null : value instanceof Date ? value : new Date(value));

/** One step as `json_build_object` wrote it, back into the shape the narrative reads. */
function journalStep(row: Record<string, unknown>): CvJournalStep {
  return {
    id: String(row.id),
    seq: Number(row.seq),
    attempt: Number(row.attempt ?? 1),
    taskId: typeof row.taskId === "string" ? row.taskId : null,
    stage: String(row.stage),
    motion: String(row.motion),
    title: String(row.title),
    status: row.status as CvJournalStep["status"],
    startedAt: new Date(String(row.startedAt)),
    finishedAt: row.finishedAt ? new Date(String(row.finishedAt)) : null,
    ms: row.ms === null || row.ms === undefined ? null : Number(row.ms),
    detail: row.detail && typeof row.detail === "object" ? (row.detail as Record<string, unknown>) : {},
    error: typeof row.error === "string" ? row.error : null,
    failure: (row.failure as CvJournalStep["failure"]) ?? null,
  };
}

export interface CvProgressWindow {
  /** Only steps after this `seq` — plus any still open, and any closed since `last`. 0 for all. */
  after?: number;
  /** The newest moment the reader already has: steps that closed later come back with the delta. */
  last?: Date | null;
}

/**
 * Everything one reading of a build needs, in one query: the draft's own state, the newest queue
 * row behind it, whether any row for it is still at work, the worker's heartbeat, the ledger's
 * signature over every row, and the rows the reader has not seen — those after the last `seq` it
 * has, those still open, and those that closed after the newest moment it has.
 *
 * This is the progress feed's whole cost per poll, beside the session lookup: the page polls it
 * every ten to thirty seconds per open tab, so it is one round trip, not the three sequential reads
 * and the separate ledger aggregate the version token used to take. Read through the owner: the
 * draft, its steps and its tasks are reached only by an id this account owns.
 *
 * Guarded for a release serving ahead of the worker's migration: a database without the build
 * columns or the ledger reads as a build that has recorded nothing, never an error.
 */
export async function readCvProgress(userId: string, draftId: string, window: CvProgressWindow = {}): Promise<CvProgressRows | null> {
  // `seq` is an int4: a larger bound would be a type error in the database, not an empty delta.
  const after = Math.min(2_147_483_647, Math.max(0, Math.floor(window.after ?? 0)));
  const last = window.last ? window.last.toISOString() : null;
  let row: CvProgressRow | undefined;
  try {
    const result = await db().execute<CvProgressRow>(sql`
      select d.status, d.build_stage as "buildStage", d.error, d.created_at as "createdAt",
        d.progress_at as "progressAt", d.failure, d.build_checkpoint as "buildCheckpoint",
        t.status as "taskStatus", t.attempts, t.max_attempts as "maxAttempts", t.error as "taskError",
        t.started_at as "taskStartedAt",
        exists (select 1 from tasks a where a.payload->>'draftId' = d.id::text and a.status in ('queued', 'running')) as "anyTaskActive",
        (select h.value from settings h where h.key = 'internal:workerHeartbeat') as heartbeat,
        agg.n, agg.running,
        to_char(date_trunc('milliseconds', agg.last) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as last,
        rows.steps
      from cv_drafts d
      left join lateral (
        select q.status, q.attempts, q.max_attempts, q.error, q.started_at from tasks q
        where q.type = 'generate_cv' and q.payload->>'draftId' = d.id::text
        order by case when q.status in ('queued', 'running') then 0 else 1 end, q.created_at desc, q.id desc
        limit 1
      ) t on true
      left join lateral (
        select count(*)::int as n, count(*) filter (where s.status = 'running')::int as running,
          max(coalesce(s.finished_at, s.started_at)) as last
        from cv_build_steps s where s.draft_id = d.id and s.user_id = d.user_id
      ) agg on true
      left join lateral (
        select json_agg(json_build_object(
          'id', s.id, 'seq', s.seq, 'attempt', s.attempt, 'taskId', s.task_id, 'stage', s.stage,
          'motion', s.motion, 'title', s.title, 'status', s.status, 'startedAt', s.started_at,
          'finishedAt', s.finished_at, 'ms', s.ms, 'detail', s.detail, 'error', s.error, 'failure', s.failure
        ) order by s.seq) as steps
        from cv_build_steps s
        where s.draft_id = d.id and s.user_id = d.user_id
          and (s.seq > ${after} or s.status = 'running'
            or date_trunc('milliseconds', s.finished_at) > coalesce(${last}::timestamptz, '-infinity'::timestamptz))
      ) rows on true
      where d.id = ${draftId} and d.user_id = ${userId}`);
    row = result.rows[0];
  } catch (error) {
    // Only a schema the worker has not migrated yet is read the older way. Anything else — a
    // statement timeout, a dropped connection — is this reading failing, and the poller backs off:
    // answering it with an empty ledger would wipe the narrative the page already shows, and
    // following the failed query with two more would add load to a database already struggling.
    if (!isSchemaBehind(error)) throw error;
    return readCvProgressBehind(userId, draftId);
  }
  if (!row) return null;
  const heartbeat = readHeartbeat(row.heartbeat);
  const worker = deriveWorkerStatus({ heartbeat, restartsLastHour: 0, restartsLastDay: 0 });
  const steps = (row.steps ?? []).map(journalStep);
  return {
    draft: {
      status: row.status,
      buildStage: row.buildStage,
      error: row.error,
      createdAt: asDate(row.createdAt)!,
      progressAt: asDate(row.progressAt),
      failure: row.failure ?? null,
      buildCheckpoint: row.buildCheckpoint ?? null,
    },
    task: row.taskStatus
      ? {
          status: row.taskStatus,
          attempts: Number(row.attempts ?? 0),
          maxAttempts: Number(row.maxAttempts ?? 0),
          error: row.taskError,
          startedAt: asDate(row.taskStartedAt),
          workerStopped: worker.state === "stopped",
        }
      : null,
    anyTaskActive: !!row.anyTaskActive,
    steps,
    signature: `${row.n ?? 0}:${row.running ?? 0}:${row.last ?? ""}`,
  };
}

/** PostgreSQL's codes for a missing table and a missing column. */
const SCHEMA_BEHIND = new Set(["42P01", "42703"]);

/** Whether a query failed because the schema lacks a table or column, however the driver wrapped it. */
export function isSchemaBehind(error: unknown): boolean {
  for (let cause = error, depth = 0; cause && typeof cause === "object" && depth < 5; cause = (cause as { cause?: unknown }).cause, depth += 1) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && SCHEMA_BEHIND.has(code)) return true;
  }
  return false;
}

/** The same reading from a database the worker has not migrated: the draft and its task, no ledger. */
async function readCvProgressBehind(userId: string, draftId: string): Promise<CvProgressRows | null> {
  const owned = and(eq(cvDrafts.id, draftId), eq(cvDrafts.userId, userId));
  const [draft] = await db()
    .select({ status: cvDrafts.status, buildStage: cvDrafts.buildStage, error: cvDrafts.error, createdAt: cvDrafts.createdAt })
    .from(cvDrafts)
    .where(owned)
    .limit(1);
  if (!draft) return null;
  const task = await getOwnCvBuildTask(userId, draftId);
  return {
    draft: { ...draft, progressAt: null, failure: null, buildCheckpoint: null },
    task,
    anyTaskActive: task?.status === "queued" || task?.status === "running",
    steps: [],
    signature: "0:0:",
  };
}

/**
 * The newest queue row behind one account's build, by the draft id in its payload. It carries the
 * only evidence that a draft stuck on "generating" has anything working on it: the attempt number,
 * whether it is claimed, and the error a handed-back attempt left. Reached through the draft, so
 * it is never read without the account that owns it.
 *
 * The payload is the stable relationship: a quiz continuation deliberately uses another dedupe
 * key so it cannot collide with the worker task that just paused. The newest row is the attempt
 * this page is about.
 *
 * It also says whether the worker is running at all. Only the worker builds CVs — a build does not
 * fit a serverless invocation, so the cron fallback never claims one — and a deployment whose
 * worker is down queued builds that said "Waiting for the worker" for as long as it stayed down.
 */
export async function getOwnCvBuildTask(userId: string, draftId: string) {
  const [row, heartbeat] = await Promise.all([ownCvBuildTaskRow(userId, draftId), getWorkerHeartbeat()]);
  if (!row) return null;
  const worker = deriveWorkerStatus({ heartbeat, restartsLastHour: 0, restartsLastDay: 0 });
  return { ...row, workerStopped: worker.state === "stopped" };
}

async function ownCvBuildTaskRow(userId: string, draftId: string) {
  const [row] = await db()
    .select({
      status: tasks.status,
      attempts: tasks.attempts,
      maxAttempts: tasks.maxAttempts,
      error: tasks.error,
      startedAt: tasks.startedAt,
    })
    .from(tasks)
    .innerJoin(cvDrafts, sql`${tasks.payload}->>'draftId' = ${cvDrafts.id}::text`)
    .where(and(eq(tasks.type, "generate_cv"), eq(cvDrafts.id, draftId), eq(cvDrafts.userId, userId)))
    .orderBy(sql`case when ${tasks.status} in ('queued', 'running') then 0 else 1 end`, desc(tasks.createdAt), desc(tasks.id))
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
 * How long each motion usually takes, for the estimate beside a running motion and the time left
 * once writing has closed. Only motions with at least `CV_MEDIAN_MIN_RUNS` finished runs in thirty days are
 * kept, because a median of three builds is an anecdote.
 *
 * Read across every account, but it carries nothing of anyone's: a motion name and a duration. It
 * is held for ten minutes per process, so the CV page's renders cost one aggregate every ten
 * minutes rather than one each; the progress feed never reads it.
 */
const MEDIANS_TTL_MS = 10 * 60_000;
let medians: { at: number; value: Promise<CvMotionMedians> } | null = null;

export function getCvMotionMedians(now: number = Date.now()): Promise<CvMotionMedians> {
  if (medians && now - medians.at < MEDIANS_TTL_MS) return medians.value;
  const value = cvBuildMotionStats(db(), 30)
    .then((stats) => Object.fromEntries(stats.filter((stat) => stat.done >= CV_MEDIAN_MIN_RUNS && stat.medianMs !== null && stat.medianMs > 0).map((stat) => [stat.motion, stat.medianMs!])))
    .catch(() => {
      medians = null;
      return {} as CvMotionMedians;
    });
  medians = { at: now, value };
  return value;
}

/** For tests: forget the cached medians. */
export function resetCvMotionMedians(): void {
  medians = null;
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
 *
 * Every row goes through `normaliseLibraryReview`, because the column holds what the pass that
 * wrote it wrote: a review from before a row could carry several types names one `facet`, and a
 * row whose tags have not changed still matches by hash, so those reviews are live rather than
 * historical. Read raw, their rows would carry no types at all.
 */
async function readLibraryReviews(userId: string, content: CvLibrary): Promise<Map<string, StoredLibraryReview>> {
  const wanted = content.entries.map(entry => ({
    entryId: entry.id,
    inputHash: libraryEntryInputHash(entry, content.employment?.find(job => job.id === entry.employmentId) ?? null),
  }));
  try {
    const rows = await latestLibraryReviews(db(), userId, wanted);
    return new Map([...rows].map(([entryId, row]) => [entryId, { entryId, source: row.source, review: normaliseLibraryReview(row.review) }]));
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
