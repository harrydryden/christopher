import { and, desc, eq, gte, sql } from "drizzle-orm";
import { CV_BUILD_MOTIONS, type CvBuildFailure, type CvBuildMotion, type CvBuildStepStatus, type CvBuildStepView } from "@christopher/core";
import type { Db } from "./client";
import { cvBuildSteps } from "./schema";

export interface StartCvBuildStep {
  draftId: string;
  userId: string;
  taskId?: string | null;
  attempt: number;
  motion: CvBuildMotion;
  /** Overrides the motion's standard title when the moment calls for a more specific one. */
  title?: string;
  detail?: Record<string, unknown>;
}

/** Open a step: the next `seq` for the draft, status `running`. Returns the row id. */
export async function startCvBuildStep(db: Db, step: StartCvBuildStep): Promise<string> {
  const { stage, title } = CV_BUILD_MOTIONS[step.motion];
  const [row] = await db.insert(cvBuildSteps).values({
    draftId: step.draftId, userId: step.userId, taskId: step.taskId ?? null, attempt: step.attempt,
    seq: sql`coalesce((select max(seq) from cv_build_steps where draft_id = ${step.draftId}), 0) + 1`,
    stage, motion: step.motion, title: step.title ?? title, status: "running", detail: step.detail ?? {},
  }).returning({ id: cvBuildSteps.id });
  return row!.id;
}

export interface FinishCvBuildStep {
  status: Exclude<CvBuildStepStatus, "running">;
  /** Merged over the detail the step started with. */
  detail?: Record<string, unknown>;
  error?: string | null;
  failure?: CvBuildFailure | null;
}

/** Close a step with its outcome; `ms` is measured from its own `started_at` by the database. */
export async function finishCvBuildStep(db: Db, id: string, outcome: FinishCvBuildStep): Promise<void> {
  await db.update(cvBuildSteps).set({
    status: outcome.status,
    finishedAt: sql`now()`,
    ms: sql`greatest(0, (extract(epoch from now()) - extract(epoch from ${cvBuildSteps.startedAt})) * 1000)::int`,
    detail: sql`${cvBuildSteps.detail} || ${JSON.stringify(outcome.detail ?? {})}::jsonb`,
    error: outcome.error ?? null,
    failure: outcome.failure ?? null,
  }).where(eq(cvBuildSteps.id, id));
}

/** Any step still `running` for the draft is closed as `failed`: the process that owned it is gone. */
export async function failOpenCvBuildSteps(db: Db, draftId: string, error: string, failure?: CvBuildFailure): Promise<number> {
  const rows = await db.update(cvBuildSteps).set({
    status: "failed", finishedAt: sql`now()`,
    ms: sql`greatest(0, (extract(epoch from now()) - extract(epoch from ${cvBuildSteps.startedAt})) * 1000)::int`,
    error, failure: failure ?? null,
  }).where(and(eq(cvBuildSteps.draftId, draftId), eq(cvBuildSteps.status, "running"))).returning({ id: cvBuildSteps.id });
  return rows.length;
}

/** The draft's steps in order, for the page. Read through the owner, never without one. */
export async function listCvBuildSteps(db: Db, userId: string, draftId: string): Promise<CvBuildStepView[]> {
  const rows = await db.select().from(cvBuildSteps)
    .where(and(eq(cvBuildSteps.draftId, draftId), eq(cvBuildSteps.userId, userId)))
    .orderBy(cvBuildSteps.seq);
  return rows.map(row => ({
    id: row.id, seq: row.seq, attempt: row.attempt, stage: row.stage, motion: row.motion, title: row.title, status: row.status,
    startedAt: row.startedAt, finishedAt: row.finishedAt, ms: row.ms, detail: row.detail, error: row.error, failure: row.failure,
  }));
}

/**
 * A token that changes whenever the narrative would: the page's poll compares it, so a step
 * starting or finishing refreshes the page without a second mechanism.
 */
export async function cvBuildStepsSignature(db: Db, draftId: string): Promise<string> {
  const [row] = await db.select({
    n: sql<number>`count(*)::int`,
    last: sql<string | null>`max(coalesce(${cvBuildSteps.finishedAt}, ${cvBuildSteps.startedAt}))::text`,
    running: sql<number>`count(*) filter (where ${cvBuildSteps.status} = 'running')::int`,
  }).from(cvBuildSteps).where(eq(cvBuildSteps.draftId, draftId));
  return `${row?.n ?? 0}:${row?.running ?? 0}:${row?.last ?? ""}`;
}

export interface CvBuildMotionStat {
  motion: CvBuildMotion;
  runs: number;
  failed: number;
  medianMs: number | null;
  medianUsd: number | null;
}

/** Where builds spend their time and where they fail, by motion, over a window. For Operations. */
export async function cvBuildMotionStats(db: Db, days = 30): Promise<CvBuildMotionStat[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db.select({
    motion: cvBuildSteps.motion,
    runs: sql<number>`count(*)::int`,
    failed: sql<number>`count(*) filter (where ${cvBuildSteps.status} = 'failed')::int`,
    medianMs: sql<number | null>`percentile_cont(0.5) within group (order by ${cvBuildSteps.ms})::int`,
    medianUsd: sql<number | null>`percentile_cont(0.5) within group (order by (${cvBuildSteps.detail}->>'usd')::float8)`,
  }).from(cvBuildSteps).where(gte(cvBuildSteps.startedAt, since)).groupBy(cvBuildSteps.motion).orderBy(desc(sql`count(*)`));
  return rows.map(row => ({ ...row, medianUsd: row.medianUsd === null ? null : Number(row.medianUsd) }));
}
