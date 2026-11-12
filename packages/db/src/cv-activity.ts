import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "./client";
import { cvActivityEvents, cvBuildSteps, cvDrafts, tasks } from "./schema";

export type CvActivityStatus = "queued" | "generating" | "awaiting_evidence" | "awaiting_priorities" | "ready" | "failed";

/** Ready/failed IDs are durable event UUIDs; an in-flight ID is `draft:<draft UUID>`. */
export interface CvActivity {
  id: string;
  draftId: string;
  contextId: string | null;
  company: string;
  jobTitle: string;
  status: CvActivityStatus;
  /** The latest canonical build-journal stage; null before a build has opened a step. */
  stage: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  read: boolean;
  unread: boolean;
  /** Internal inputs for the web build-state calculation; omit from the public response. */
  work?: {
    progressAt: Date | null;
    failure: typeof cvDrafts.$inferSelect["failure"];
    error: string | null;
    task: {
      status: typeof tasks.$inferSelect["status"];
      attempts: number;
      maxAttempts: number;
      error: string | null;
      startedAt: Date | null;
    } | null;
  };
}

/** Current account builds and recent unread completion events, newest first. */
export async function getCvActivities(db: Db, userId: string): Promise<CvActivity[]> {
  const [active, completed] = await Promise.all([
    db.select({
      id: cvDrafts.id, contextId: cvDrafts.contextId, company: cvDrafts.companyName,
      jobTitle: cvDrafts.jobTitle, status: cvDrafts.status, createdAt: cvDrafts.createdAt,
      progressAt: cvDrafts.progressAt, failure: cvDrafts.failure, error: cvDrafts.error,
    }).from(cvDrafts).where(and(eq(cvDrafts.userId, userId),
      sql`${cvDrafts.status} in ('queued', 'generating', 'awaiting_evidence', 'awaiting_priorities')`,
      sql`${cvDrafts.archivedAt} is null`,
      sql`${cvDrafts.editingMode} is distinct from 'manual'`,
      sql`${cvDrafts.model} <> 'manual'`,
      sql`(exists (select 1 from cv_build_steps s where s.draft_id = ${cvDrafts.id})
        or exists (select 1 from tasks t where t.type = 'generate_cv' and t.payload->>'draftId' = ${cvDrafts.id}::text))`))
      .orderBy(desc(cvDrafts.createdAt)).limit(50),
    db.select({ event: cvActivityEvents }).from(cvActivityEvents)
      .innerJoin(cvDrafts, and(eq(cvDrafts.id, cvActivityEvents.draftId), eq(cvDrafts.userId, cvActivityEvents.userId)))
      .where(and(eq(cvActivityEvents.userId, userId), isNull(cvActivityEvents.readAt), eq(cvDrafts.status, cvActivityEvents.status),
        sql`${cvActivityEvents.createdAt} >= now() - interval '30 days'`))
      .orderBy(desc(cvActivityEvents.createdAt)).limit(50),
  ]);
  const taskDraftId = sql<string>`${tasks.payload}->>'draftId'`;
  const [steps, latestTasks] = await Promise.all([
    active.length ? db.selectDistinctOn([cvBuildSteps.draftId], { draftId: cvBuildSteps.draftId, stage: cvBuildSteps.stage,
      startedAt: cvBuildSteps.startedAt, finishedAt: cvBuildSteps.finishedAt })
      .from(cvBuildSteps).where(inArray(cvBuildSteps.draftId, active.map(row => row.id)))
      .orderBy(cvBuildSteps.draftId, desc(cvBuildSteps.seq)) : [],
    active.length ? db.selectDistinctOn([taskDraftId], {
      draftId: taskDraftId, status: tasks.status, attempts: tasks.attempts,
      maxAttempts: tasks.maxAttempts, error: tasks.error, startedAt: tasks.startedAt,
    }).from(tasks).where(and(eq(tasks.type, "generate_cv"), inArray(taskDraftId, active.map(row => row.id))))
      .orderBy(taskDraftId, sql`case when ${tasks.status} in ('queued', 'running') then 0 else 1 end`,
        desc(tasks.createdAt), desc(tasks.id)) : [],
  ]);
  const lastStep = new Map(steps.map(step => [step.draftId, step]));
  const taskByDraft = new Map(latestTasks.map(({ draftId, ...task }) => [draftId, task]));

  const items: CvActivity[] = [
    ...active.map(row => ({ id: `draft:${row.id}`, draftId: row.id, contextId: row.contextId,
      company: row.company, jobTitle: row.jobTitle, status: row.status, stage: lastStep.get(row.id)?.stage ?? null,
      createdAt: row.createdAt, updatedAt: new Date(Math.max(row.createdAt.getTime(), row.progressAt?.getTime() ?? 0,
        lastStep.get(row.id)?.finishedAt?.getTime() ?? lastStep.get(row.id)?.startedAt.getTime() ?? 0)), completedAt: null,
      read: true, unread: false,
      work: { progressAt: row.progressAt, failure: row.failure, error: row.error,
        task: taskByDraft.get(row.id) ?? null } })),
    ...completed.map(({ event: row }) => ({ id: row.id, draftId: row.draftId, contextId: row.contextId,
      company: row.company, jobTitle: row.jobTitle, status: row.status, stage: null,
      createdAt: row.createdAt, updatedAt: row.createdAt, completedAt: row.createdAt,
      read: row.readAt !== null, unread: row.readAt === null })),
  ];
  return items.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/** Idempotently mark this exact completion read for its owner; false means no such event. */
export async function acknowledgeCvActivity(db: Db, userId: string, eventId: string): Promise<boolean> {
  const rows = await db.update(cvActivityEvents).set({ readAt: sql`coalesce(${cvActivityEvents.readAt}, now())` })
    .where(and(eq(cvActivityEvents.id, eventId), eq(cvActivityEvents.userId, userId)))
    .returning({ id: cvActivityEvents.id });
  return rows.length > 0;
}
