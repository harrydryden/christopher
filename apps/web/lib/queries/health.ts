import { scanRunReports } from "@/lib/scan-run-report";
import { and, asc, desc, eq, gte, inArray, isNotNull, ne, sql, getTableColumns } from "drizzle-orm";
import {
  aiUsageByAccount,
  costPerCvBuild,
  costPerScoredRole,
  countWorkerEvents,
  cvBuildMotionStats,
  type CvBuildMotionStat,
  listHttpHostDaily,
  listWorkerEvents,
  totalAiSpend,
  type CvBuildCosts,
  type ScoredRoleCost,
} from "@ava/db";
import {
  cvBuildSteps,
  cvDrafts,
  discoveryRuns,
  jobs,
  settings,
  careerSources,
  companies,
  companySubscriptions,
  scanRuns,
  scans,
  tasks,
  users,
  workerEvents,
  type CareerSource,
  type Task,
  type WorkerEventKind,
} from "@ava/db/schema";
// The deadline table lives in packages/core so the interface can say how long a running task has
// left without importing the worker.
import { aiBudgetWindowStart, deadlineFor } from "@ava/core";
import { cache } from "react";
import { groupAiUsage, type AiUsageGroup } from "@/lib/ai-usage";
import { accountAiBudget } from "@/lib/queries/accounts";
import { formatUsd } from "@/lib/format";
import { foldOutboundTraffic, type HostTraffic } from "@/lib/outbound-traffic";
import { db } from "@/lib/db";
import { deriveWorkerStatus, type WorkerHeartbeat, type WorkerStatus, type WorkerVitals } from "@/lib/worker-status";

/** Companies one account follows; with no account, every company (the administrator's view). */
function followedBy(userId?: string) {
  return userId ? sql`exists (select 1 from company_subscriptions s where s.company_id = ${companies.id} and s.user_id = ${userId} and s.status <> 'archived')` : undefined;
}

/** career_sources whose status needs a human, with the owning company's name for linking. */
export async function listSourcesNeedingAttention(userId?: string): Promise<Array<CareerSource & { companyName: string }>> {
  const rows = await db()
    .select({ source: careerSources, companyName: companies.name })
    .from(careerSources)
    .innerJoin(companies, eq(careerSources.companyId, companies.id))
    .where(and(inArray(careerSources.status, ["needs_confirmation", "failing", "blocked"]), followedBy(userId)))
    .orderBy(desc(careerSources.createdAt)).limit(100);
  return rows.map((r) => ({ ...r.source, companyName: r.companyName }));
}

/** Non-archived companies with zero career_sources at all. */
export async function listCompaniesWithNoSource(userId?: string): Promise<Array<{ id: string; name: string }>> {
  const rows = await db()
    .select({ id: companies.id, name: companies.name, sourceCount: sql<number>`count(${careerSources.id})::int` })
    .from(companies)
    .leftJoin(careerSources, eq(careerSources.companyId, companies.id))
    .where(and(ne(companies.status, "archived"), followedBy(userId)))
    .groupBy(companies.id)
    .having(sql`count(${careerSources.id}) = 0`).orderBy(companies.name).limit(100);
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

export interface ProblemScanRow {
  scan: Omit<typeof scans.$inferSelect, "rawSnapshot">;
  companyId: string;
  companyName: string;
  sourceType: CareerSource["type"];
}

export async function listRecentProblemScans(userId?: string, days = 7): Promise<ProblemScanRow[]> {
  const { rawSnapshot: _raw, ...scanColumns } = getTableColumns(scans);
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db()
    .select({ scan: scanColumns, companyId: companies.id, companyName: companies.name, sourceType: careerSources.type })
    .from(scans)
    .innerJoin(careerSources, eq(scans.sourceId, careerSources.id))
    .innerJoin(companies, eq(careerSources.companyId, companies.id))
    .where(and(ne(scans.status, "ok"), gte(scans.startedAt, since), followedBy(userId)))
    .orderBy(desc(scans.startedAt)).limit(100);
  return rows.map((r) => ({ scan: r.scan, companyId: r.companyId, companyName: r.companyName, sourceType: r.sourceType }));
}

export async function listFailedTasks(limit = 50): Promise<Task[]> {
  return db()
    .select()
    .from(tasks)
    .where(eq(tasks.status, "failed"))
    .orderBy(desc(tasks.finishedAt))
    .limit(limit);
}

export interface QueueCount {
  type: Task["type"];
  status: Task["status"];
  n: number;
}

export async function getQueueCounts(): Promise<QueueCount[]> {
  return db()
    .select({ type: tasks.type, status: tasks.status, n: sql<number>`count(*)::int` })
    .from(tasks)
    .groupBy(tasks.type, tasks.status)
    .orderBy(tasks.type, tasks.status);
}

/**
 * Everything spent since `since`, whoever it was for: every account's calls and the work no
 * account asked for, together. Budgets are per account and each carries its own window, so this is
 * Operations' report of the deployment rather than a limit anything is measured against.
 */
export async function getTotalAiSpend(since: Date): Promise<number> {
  return totalAiSpend(db(), since);
}

/** The operations report: one line per account, feature and model since `since`, dearest first. */
export async function getAiUsage(since: Date): Promise<AiUsageGroup[]> {
  return groupAiUsage(await aiUsageByAccount(db(), since));
}

/**
 * What the last `limit` CV builds cost, itemised by stage. Administrator-only: it reads every
 * account's drafts, so the page behind it calls `requireAdmin` and it is never used per account.
 */
export async function getCvBuildCosts(limit = 20): Promise<CvBuildCosts> {
  const costs = await ifLedger(() => costPerCvBuild(db(), limit), { builds: [], medianUsd: null, worstUsd: null, stages: [] });
  return normaliseCvBuildCosts(costs);
}

/** Decode raw aggregate timestamps before the Operations page formats them. */
export function normaliseCvBuildCosts(costs: CvBuildCosts): CvBuildCosts {
  return {
    ...costs,
    builds: costs.builds.map(build => ({ ...build, at: requiredOperationDate(build.at, "CV build") })),
  };
}

/**
 * Where builds spend their time and where they fail, by motion, over a window. Administrator-only,
 * like the costs above: it reads every account's builds, and the page behind it calls
 * `requireAdmin`. A deployment whose worker has not yet run the ledger's migration reads as an
 * empty card rather than an error over the whole of Operations.
 */
export async function getCvBuildMotions(days = 30): Promise<CvBuildMotionStat[]> {
  return ifLedger(() => cvBuildMotionStats(db(), days), [] as CvBuildMotionStat[]);
}

export interface CvBuildFailureCount {
  kind: string;
  /** What the failure record said about whose move it was: "system" or "user". */
  resolvedBy: string;
  count: number;
  lastAt: Date | null;
}

/**
 * What builds have failed of, over a window, counted by kind and by whose move it was. The counts
 * come from the steps' own failure records rather than from the drafts, so an attempt the system
 * resolved by retrying is counted too — those are exactly the failures nobody would otherwise see.
 */
export async function getCvBuildFailureKinds(days = 30): Promise<CvBuildFailureCount[]> {
  return ifLedger(async () => {
    const since = new Date(Date.now() - days * 86_400_000);
    const kind = sql<string>`${cvBuildSteps.failure}->>'kind'`;
    const resolvedBy = sql<string>`${cvBuildSteps.failure}->>'resolvedBy'`;
    const rows = await db()
      .select({ kind, resolvedBy, count: sql<number>`count(*)::int`, lastAt: sql<Date>`max(${cvBuildSteps.startedAt})` })
      .from(cvBuildSteps)
      .where(and(gte(cvBuildSteps.startedAt, since), isNotNull(cvBuildSteps.failure)))
      .groupBy(kind, resolvedBy)
      // Commonest first, then most recent, then by name: two kinds that have happened as often as
      // each other are a card that reorders itself between refreshes without the last two.
      .orderBy(desc(sql`count(*)`), desc(sql`max(${cvBuildSteps.startedAt})`), kind);
    return rows.map((row) => ({
      kind: row.kind ?? "unknown",
      resolvedBy: row.resolvedBy ?? "unknown",
      count: row.count,
      lastAt: row.lastAt ? new Date(row.lastAt) : null,
    }));
  }, [] as CvBuildFailureCount[]);
}

/** What scoring one role costs over `days` — the unit price of the highest-volume call site. */
export async function getScoredRoleCost(days = 30): Promise<ScoredRoleCost> {
  return ifLedger(() => costPerScoredRole(db(), days), { roles: 0, calls: 0, totalUsd: 0, meanUsd: null, medianUsd: null });
}

/**
 * Outbound traffic per host for the last `days` days, with the `days` before them for a delta.
 * Twice the window is read in one query and split on the boundary, so one pass answers both.
 */
export async function outboundTraffic(days = 7): Promise<HostTraffic[]> {
  const rows = await ifLedger(() => listHttpHostDaily(db(), days * 2), [] as Awaited<ReturnType<typeof listHttpHostDaily>>);
  return foldOutboundTraffic(rows, days);
}

/** Health's run history: one query for the runs, one for every run's counts. */
export async function listRecentScanRuns(limit = 10, userId?: string) {
  const runs = await db().select().from(scanRuns).orderBy(desc(scanRuns.startedAt)).limit(limit);
  return scanRunReports(runs, userId);
}

/** PostgreSQL timestamps may cross a pooled/serverless boundary as ISO strings rather than Dates. */
export const operationDate = (value: unknown): Date | null => {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value) : null;
};
export const requiredOperationDate = (value: unknown, field: string): Date => {
  const parsed = operationDate(value);
  if (!parsed) throw new Error(`Operations received an invalid ${field} timestamp.`);
  return parsed;
};
const isoDate = operationDate;
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** The vitals block, or null for a heartbeat written before the worker reported one. */
function readVitals(value: unknown): WorkerVitals | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const heapUsedMb = finite(v.heapUsedMb);
  const heapLimitMb = finite(v.heapLimitMb);
  if (heapUsedMb === null || heapLimitMb === null || heapLimitMb <= 0) return null;
  return {
    heapUsedMb,
    heapLimitMb,
    heapFraction: finite(v.heapFraction) ?? heapUsedMb / heapLimitMb,
    rssMb: finite(v.rssMb) ?? 0,
    externalMb: finite(v.externalMb) ?? 0,
    uptimeSeconds: finite(v.uptimeSeconds) ?? 0,
  };
}

/**
 * Last report from the persistent worker; configuration is not a successful API probe.
 *
 * A row written by an older worker carries only `at`, the two configuration flags and the commit.
 * Everything added since — the boot time, the memory reading, the worker's id and what it is
 * running — is read as null when it is absent rather than assumed.
 */
export async function getWorkerHeartbeat(): Promise<WorkerHeartbeat | null> {
  const [row] = await db().select({ value: settings.value }).from(settings)
    .where(eq(settings.key, "internal:workerHeartbeat")).limit(1);
  const value = row?.value as Record<string, unknown> | undefined;
  const at = isoDate(value?.at);
  if (!value || !at) return null;
  return {
    at,
    workerId: typeof value.workerId === "string" ? value.workerId : null,
    commit: typeof value.commit === "string" && /^[a-f0-9]{40}$/.test(value.commit) ? value.commit : null,
    aiConfigured: value.aiConfigured === true,
    browserAvailable: value.browserAvailable === true,
    bootedAt: isoDate(value.bootedAt),
    vitals: readVitals(value.vitals),
    active: finite(value.active),
    concurrency: finite(value.concurrency),
  };
}

/**
 * The interface deploys independently of the worker, which is what runs the migrations, so a
 * release can be serving before `worker_events` exists. A missing ledger is "nothing recorded",
 * not an error page over the whole of Operations.
 */
async function ifLedger<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

/**
 * Is the worker running, being restarted, or gone? The heartbeat is rewritten on every boot, so it
 * cannot answer this alone; the crash-recovery ledger can. See lib/worker-status.ts for the rules.
 */
export async function getWorkerStatus(now: Date = new Date()): Promise<WorkerStatus> {
  const hour = new Date(now.getTime() - 3_600_000);
  const day = new Date(now.getTime() - 86_400_000);
  const [heartbeat, restartsLastHour, restartsLastDay, boots] = await Promise.all([
    getWorkerHeartbeat(),
    ifLedger(() => countWorkerEvents(db(), "crash_recovery", hour), 0),
    ifLedger(() => countWorkerEvents(db(), "crash_recovery", day), 0),
    ifLedger(() => listWorkerEvents(db(), { kinds: ["boot"], limit: 1 }), [] as Awaited<ReturnType<typeof listWorkerEvents>>),
  ]);
  // The heartbeat does not carry how many slots the process was given; its boot line does.
  const boot = boots[0];
  const withBoot = heartbeat && heartbeat.concurrency === null && boot?.workerId === heartbeat.workerId
    ? { ...heartbeat, concurrency: finite(boot.detail?.concurrency) }
    : heartbeat;
  return deriveWorkerStatus({ heartbeat: withBoot, restartsLastHour, restartsLastDay, now });
}

/* ---------------------------------------------------------------------------------------------
 * Naming the work
 *
 * A task row says `scan_company` and a uuid. Operations needs the company, the CV or the account,
 * because "which company was the worker holding when it died" is the whole question during a crash
 * loop. Subjects are resolved in one batch per kind, for the whole page.
 * ------------------------------------------------------------------------------------------- */

export type SubjectKind = "company" | "cv" | "user" | "source" | "job";
export interface SubjectRef {
  kind: SubjectKind;
  id: string;
}

/** Which payload field names the thing a task is about, per task type. */
const SUBJECT_FIELDS: Partial<Record<Task["type"], { kind: SubjectKind; field: string }>> = {
  generate_cv: { kind: "cv", field: "draftId" },
  review_library: { kind: "user", field: "userId" },
  import_library_document: { kind: "user", field: "userId" },
  scan_company: { kind: "company", field: "companyId" },
  discover: { kind: "company", field: "companyId" },
  profile_company: { kind: "company", field: "companyId" },
  reevaluate_gate: { kind: "company", field: "companyId" },
  monitor_source: { kind: "source", field: "sourceId" },
  extract_document: { kind: "source", field: "sourceId" },
  verify_company: { kind: "source", field: "sourceId" },
  fetch_description: { kind: "job", field: "jobId" },
  score_job: { kind: "job", field: "jobId" },
  synthesize_profile: { kind: "user", field: "userId" },
  suggest_filters: { kind: "user", field: "userId" },
  suggest_from_scans: { kind: "user", field: "userId" },
  suggest_companies: { kind: "user", field: "userId" },
  rescore_all: { kind: "user", field: "userId" },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The subject a task payload names, or null for work that is about nothing in particular. */
export function taskSubjectRef(type: string, payload: unknown): SubjectRef | null {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const mapping = SUBJECT_FIELDS[type as Task["type"]];
  const id = mapping && typeof p[mapping.field] === "string" ? (p[mapping.field] as string) : undefined;
  if (id && UUID.test(id)) return { kind: mapping!.kind, id };
  // Work that names an account and nothing else, and the account half of a payload whose own
  // subject is missing, still identifies whose queue is stuck.
  if (typeof p.userId === "string" && UUID.test(p.userId)) return { kind: "user", id: p.userId };
  return null;
}

export type SubjectNames = Map<string, string>;
const subjectKey = (ref: SubjectRef) => `${ref.kind}:${ref.id}`;

/**
 * Human names for a page's worth of subjects, one query per kind. CV drafts are per-account data:
 * they are read here only for an administrator, and each is labelled with the account that owns it
 * rather than being shown loose.
 */
export async function resolveSubjects(refs: Array<SubjectRef | null>): Promise<SubjectNames> {
  const names: SubjectNames = new Map();
  const ids = (kind: SubjectKind) => [...new Set(refs.filter((r): r is SubjectRef => r?.kind === kind).map((r) => r.id))];
  const companyIds = ids("company");
  const cvIds = ids("cv");
  const userIds = ids("user");
  const sourceIds = ids("source");
  const jobIds = ids("job");
  await Promise.all([
    companyIds.length
      ? db().select({ id: companies.id, name: companies.name }).from(companies).where(inArray(companies.id, companyIds))
          .then((rows) => rows.forEach((r) => names.set(`company:${r.id}`, r.name)))
      : null,
    cvIds.length
      ? db().select({ id: cvDrafts.id, company: cvDrafts.companyName, title: cvDrafts.jobTitle, userId: cvDrafts.userId })
          .from(cvDrafts).where(inArray(cvDrafts.id, cvIds))
          .then((rows) => rows.forEach((r) => names.set(`cv:${r.id}`, `CV: ${r.company} · ${r.title}`)))
      : null,
    userIds.length
      ? db().select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, userIds))
          .then((rows) => rows.forEach((r) => names.set(`user:${r.id}`, r.email)))
      : null,
    sourceIds.length
      ? db().select({ id: careerSources.id, type: careerSources.type, name: companies.name })
          .from(careerSources).innerJoin(companies, eq(careerSources.companyId, companies.id))
          .where(inArray(careerSources.id, sourceIds))
          .then((rows) => rows.forEach((r) => names.set(`source:${r.id}`, `${r.name} (${r.type})`)))
      : null,
    jobIds.length
      ? db().select({ id: jobs.id, title: jobs.title, name: companies.name })
          .from(jobs).innerJoin(companies, eq(jobs.companyId, companies.id)).where(inArray(jobs.id, jobIds))
          .then((rows) => rows.forEach((r) => names.set(`job:${r.id}`, `${r.name} · ${r.title}`)))
      : null,
  ]);
  return names;
}

/** The name for one reference, falling back to a shortened id so a row is never blank. */
export function subjectName(ref: SubjectRef | null, names: SubjectNames): string | null {
  if (!ref) return null;
  return names.get(subjectKey(ref)) ?? `${ref.kind} ${ref.id.slice(0, 8)}`;
}

/* ---------------------------------------------------------------------------------------------
 * The worker's own ledger
 * ------------------------------------------------------------------------------------------- */

export interface CrashSuspect {
  id: string | null;
  type: string | null;
  attempts: number | null;
  lockedBy: string | null;
  lockedAt: Date | null;
  subject: string | null;
  likely: boolean;
}

export interface CrashRecovery {
  at: Date;
  workerId: string;
  suspects: CrashSuspect[];
}

/**
 * A suspect's `subject` is the worker's `taskSubject()`: `"<task type>:<uuid>"`, an identifier and
 * nothing a person can read. Turn it into the company, CV or account it names.
 */
function suspectRef(entry: unknown): SubjectRef | null {
  const s = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
  const subject = typeof s.subject === "string" ? s.subject : null;
  if (!subject) return null;
  const id = subject.slice(subject.lastIndexOf(":") + 1);
  if (!UUID.test(id)) return null;
  const type = typeof s.type === "string" ? s.type : subject.slice(0, subject.lastIndexOf(":"));
  return { kind: SUBJECT_FIELDS[type as Task["type"]]?.kind ?? "company", id };
}

function readSuspects(detail: Record<string, unknown>, names: SubjectNames): CrashSuspect[] {
  const raw = Array.isArray(detail.suspects) ? detail.suspects : [];
  // `likely` is recorded as the whole suspect; older rows may carry only its id.
  const likelyValue = detail.likely;
  const likelyId = typeof likelyValue === "string"
    ? likelyValue
    : likelyValue && typeof likelyValue === "object" && typeof (likelyValue as Record<string, unknown>).id === "string"
      ? ((likelyValue as Record<string, unknown>).id as string)
      : null;
  return raw.map((entry) => {
    const s = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const ref = suspectRef(entry);
    const subject = typeof s.subject === "string" ? s.subject : null;
    return {
      id: typeof s.id === "string" ? s.id : null,
      type: typeof s.type === "string" ? s.type : null,
      attempts: finite(s.attempts),
      lockedBy: typeof s.lockedBy === "string" ? s.lockedBy : null,
      lockedAt: isoDate(s.lockedAt),
      subject: (ref ? names.get(subjectKey(ref)) : null) ?? subject,
      likely: !!likelyId && likelyId === s.id,
    };
  }).sort((a, b) => Number(b.likely) - Number(a.likely));
}

/** The references a crash-recovery detail names, so the whole page resolves them in one batch. */
function crashSuspectRefs(detail: Record<string, unknown>): SubjectRef[] {
  const raw = Array.isArray(detail.suspects) ? detail.suspects : [];
  return raw.flatMap((entry) => suspectRef(entry) ?? []);
}

export interface WorkerEventRow {
  id: string;
  at: Date;
  kind: WorkerEventKind;
  workerId: string;
  taskType: string | null;
  subject: string | null;
  detail: string | null;
}

/** One line per event: what happened, to what, and the one figure that matters for its kind. */
function eventDetailLine(kind: WorkerEventKind, detail: Record<string, unknown>): string | null {
  switch (kind) {
    case "boot": {
      const v = readVitals(detail.vitals);
      const parts = [
        v ? `heap ceiling ${v.heapLimitMb} MB` : null,
        finite(detail.concurrency) !== null ? `${detail.concurrency} slots` : null,
        typeof detail.commit === "string" ? `release ${detail.commit.slice(0, 7)}` : null,
      ].filter(Boolean);
      return parts.length ? parts.join(" · ") : null;
    }
    case "crash_recovery": {
      const n = Array.isArray(detail.suspects) ? detail.suspects.length : 0;
      return `${n} task${n === 1 ? "" : "s"} were running when the process died`;
    }
    case "shutdown":
      return [
        typeof detail.signal === "string" ? detail.signal : null,
        finite(detail.handedBack) ? `${detail.handedBack} tasks handed back` : null,
        finite(detail.uptimeSeconds) !== null ? `up ${Math.round((finite(detail.uptimeSeconds) ?? 0) / 60)} min` : null,
      ].filter(Boolean).join(" · ") || null;
    case "task_abandoned":
      return [
        finite(detail.attempts) !== null ? `attempt ${detail.attempts} of ${detail.maxAttempts ?? "?"}` : null,
        typeof detail.error === "string" ? detail.error : null,
      ].filter(Boolean).join(" · ") || null;
    case "task_deadline":
      return finite(detail.elapsedMs) !== null
        ? `ran ${Math.round((finite(detail.elapsedMs) ?? 0) / 1000)}s against a ${Math.round((finite(detail.deadlineMs) ?? 0) / 1000)}s deadline`
        : null;
    case "holds_released":
      return finite(detail.count) !== null
        ? `${detail.count} AI budget holds released${typeof detail.reason === "string" ? ` on ${detail.reason}` : ""}`
        : null;
    default:
      return typeof detail.reason === "string" ? detail.reason : null;
  }
}

/** Events record their subject the way the worker writes it: `"<task type>:<uuid>"`. */
function eventRef(row: { userId: string | null; detail: Record<string, unknown> | null; taskType: string | null }): SubjectRef | null {
  const fromDetail = suspectRef({ subject: row.detail?.subject, type: row.taskType });
  if (fromDetail) return fromDetail;
  return row.userId && UUID.test(row.userId) ? { kind: "user", id: row.userId } : null;
}

/** The last 30 things the worker did, newest first, with each one's subject named. */
export async function listRecentWorkerEvents(limit = 30): Promise<WorkerEventRow[]> {
  const rows = await ifLedger(() => listWorkerEvents(db(), { limit }), [] as Awaited<ReturnType<typeof listWorkerEvents>>);
  const refs = rows.map((row) => eventRef(row));
  const names = await resolveSubjects(refs);
  return rows.map((row, i) => {
    const at = requiredOperationDate(row.at, "worker event");
    return {
      id: row.id,
      at,
      kind: row.kind,
      workerId: row.workerId,
      taskType: row.taskType,
      subject: subjectName(refs[i] ?? null, names),
      detail: eventDetailLine(row.kind, row.detail ?? {}),
    };
  });
}

/** The most recent crash recovery, with the tasks the dead process was holding. */
export async function getLastCrashRecovery(): Promise<CrashRecovery | null> {
  const [row] = await ifLedger(
    () => listWorkerEvents(db(), { kinds: ["crash_recovery"], limit: 1 }),
    [] as Awaited<ReturnType<typeof listWorkerEvents>>,
  );
  if (!row) return null;
  const at = operationDate(row.at);
  if (!at) return null;
  const detail = row.detail ?? {};
  const names = await resolveSubjects(crashSuspectRefs(detail));
  return { at, workerId: row.workerId, suspects: readSuspects(detail, names) };
}

/* ---------------------------------------------------------------------------------------------
 * What the queue is doing now
 * ------------------------------------------------------------------------------------------- */

export interface RunningTaskRow {
  id: string;
  type: Task["type"];
  subject: string | null;
  startedAt: Date | null;
  lockedBy: string | null;
  attempts: number;
  maxAttempts: number;
  /** How long this type may run before the worker abandons it. */
  deadlineMs: number;
}

/** Everything claimed right now: the tasks a crash would take with it. */
export async function listRunningTasks(limit = 25): Promise<RunningTaskRow[]> {
  const rows = await db().select().from(tasks).where(eq(tasks.status, "running"))
    .orderBy(asc(tasks.startedAt)).limit(limit);
  const refs = rows.map((row) => taskSubjectRef(row.type, row.payload));
  const names = await resolveSubjects(refs);
  return rows.map((row, i) => ({
    id: row.id,
    type: row.type,
    subject: subjectName(refs[i] ?? null, names),
    startedAt: operationDate(row.startedAt),
    lockedBy: row.lockedBy,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    deadlineMs: deadlineFor(row.type),
  }));
}

export interface RetryingTaskRow {
  id: string;
  type: Task["type"];
  subject: string | null;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  runAfter: Date;
}

/**
 * Queued tasks that have already been tried and carry an error: the ones the queue handed back
 * after a crash or a deadline. A crash-looping worker fills this list, which is how a run that is
 * being retried to death is told apart from a queue that is merely busy.
 */
export async function listRetryingTasks(limit = 25): Promise<RetryingTaskRow[]> {
  const rows = await db().select().from(tasks)
    .where(and(eq(tasks.status, "queued"), gte(tasks.attempts, 1), isNotNull(tasks.error)))
    .orderBy(desc(tasks.attempts), asc(tasks.runAfter)).limit(limit);
  const refs = rows.map((row) => taskSubjectRef(row.type, row.payload));
  const names = await resolveSubjects(refs);
  return rows.map((row, i) => {
    const runAfter = requiredOperationDate(row.runAfter, "task retry");
    return {
      id: row.id,
      type: row.type,
      subject: subjectName(refs[i] ?? null, names),
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      error: row.error,
      runAfter,
    };
  });
}

export interface ScanInputRow {
  sourceId: string;
  companyId: string;
  companyName: string;
  sourceType: CareerSource["type"];
  bytes: number;
  /** How the listing was fetched; a browser render is the dear path as well as the large one. */
  fetchMethod: string | null;
  /** Outbound requests that scan made, and how many came back 304 rather than a transfer. */
  requests: number | null;
  revalidated: number | null;
  at: Date;
}

/**
 * The largest listing each source has returned lately. A scan holds its input in memory, so this
 * is the list of pages that can take the process to its heap ceiling — the 41 MB board that spent
 * ten hours restarting the worker would have been at the top of it.
 *
 * The ranking is done in the database. Reading every source's largest scan and sorting ten of them
 * out in the interface meant carrying a row per source in the catalogue to show ten.
 */
export async function listLargestScanInputs(days = 7, limit = 10): Promise<ScanInputRow[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  const largest = db()
    .selectDistinctOn([scans.sourceId], {
      sourceId: scans.sourceId,
      companyId: sql<string>`${companies.id}`.as("company_id"),
      companyName: sql<string>`${companies.name}`.as("company_name"),
      sourceType: sql<CareerSource["type"]>`${careerSources.type}`.as("source_type"),
      bytes: sql<number>`coalesce(${scans.fetchedBytes}, 0)`.as("bytes"),
      fetchMethod: sql<string | null>`${scans.fetchMethod}`.as("fetch_method"),
      requests: sql<number | null>`${scans.requests}`.as("requests"),
      revalidated: sql<number | null>`${scans.revalidated}`.as("revalidated"),
      at: sql<Date>`${scans.startedAt}`.as("at"),
    })
    .from(scans)
    .innerJoin(careerSources, eq(scans.sourceId, careerSources.id))
    .innerJoin(companies, eq(careerSources.companyId, companies.id))
    .where(and(isNotNull(scans.fetchedBytes), gte(scans.startedAt, since)))
    .orderBy(scans.sourceId, desc(scans.fetchedBytes))
    .as("largest");
  const rows = await db().select().from(largest).orderBy(desc(largest.bytes)).limit(limit);
  return rows.map((row) => {
    const at = requiredOperationDate(row.at, "scan input");
    return {
      sourceId: row.sourceId,
      companyId: row.companyId,
      companyName: row.companyName,
      sourceType: row.sourceType,
      bytes: Number(row.bytes ?? 0),
      fetchMethod: row.fetchMethod,
      requests: row.requests === null ? null : Number(row.requests),
      revalidated: row.revalidated === null ? null : Number(row.revalidated),
      at,
    };
  });
}

export { companySubscriptions as _companySubscriptions, workerEvents as _workerEvents };

/* ---------------------------------------------------------------------------------------------
 * The attention list, and the resolution each item carries
 *
 * R-9.1: "anything that needs you appears here and nowhere else". R-9.2: "each item has a
 * one-click resolution path". One item per company, because a company with a blocked source and a
 * failing one is one problem to a person, and one item for the account's own budget.
 *
 * Every read carries the `userId`: the catalogue is shared, but which part of it needs *you*
 * depends on what you follow, and a company you have paused is not asking for anything.
 * ------------------------------------------------------------------------------------------- */

/** The worker's threshold, named here so Health says the same figure the scan handler acts on. */
import { SOURCE_FAILING_AFTER } from "@ava/core";
export { SOURCE_FAILING_AFTER };

export type HealthItemKind = "budget" | "needs_confirmation" | "no_source" | "blocked" | "failing" | "rediscovery";

/** Where each kind sits in the list: what stops everything first, proposals last. */
const KIND_ORDER: Record<HealthItemKind, number> = {
  budget: 0,
  needs_confirmation: 1,
  blocked: 2,
  failing: 3,
  no_source: 4,
  rediscovery: 5,
};

export interface HealthCandidate {
  /** Its position in the run's `candidates`, which is what `useDiscoveryCandidate` takes. */
  index: number;
  type: string | null;
  url: string | null;
  confidence: number | null;
  method: string | null;
}

export interface HealthItem {
  /** Stable across refreshes, so a row does not lose its place while a form is open. */
  key: string;
  kind: HealthItemKind;
  company: { id: string; name: string } | null;
  source: { id: string; type: CareerSource["type"]; url: string; status: CareerSource["status"]; consecutiveFailures: number } | null;
  /** The discovery run whose candidates the item offers, when it offers any. */
  runId: string | null;
  candidates: HealthCandidate[];
  /** What the worker recorded the last time it read this board. */
  reason: string | null;
  /** The account's own spend against its own budget, for the budget item. */
  budget: { spentUsd: number; limitUsd: number } | null;
}

/** The item's own line: what is wrong, in the fewest words that are still true. */
export function healthItemHeadline(item: HealthItem): string {
  switch (item.kind) {
    case "budget":
      return `AI budget spent · ${formatUsd(item.budget?.spentUsd ?? 0)} of ${formatUsd(item.budget?.limitUsd ?? 0)} this month`;
    case "needs_confirmation":
      return item.candidates.length
        ? `Discovery found ${item.candidates.length} ${item.candidates.length === 1 ? "candidate" : "candidates"}; nobody has picked one`
        : "This careers page has never been confirmed";
    case "no_source":
      return "No careers page to scan";
    case "blocked":
      return "The board is refusing our requests";
    case "failing":
      return `Failed ${item.source?.consecutiveFailures ?? 0} ${item.source?.consecutiveFailures === 1 ? "scan" : "scans"} in a row`;
    case "rediscovery":
      return "Discovery found another careers page";
  }
}

/** The sentence under the line: what it costs you, or what the worker recorded. */
export function healthItemDetail(item: HealthItem): string {
  switch (item.kind) {
    case "budget":
      return "Scoring, suggestions and CV builds stop for this account until the budget resets on the 1st.";
    case "needs_confirmation":
      return "Nothing is scanned for this company until one of them is confirmed.";
    case "no_source":
      return "Nothing is scanned for this company until a careers page is found.";
    case "blocked":
      return item.reason ?? "The site refused our requests, which no retry undoes.";
    case "failing":
      return item.reason ?? `A source is marked failing after ${SOURCE_FAILING_AFTER} failed scans in a row.`;
    case "rediscovery":
      return "A source is already scanning, so this one waits for a follower to judge it. Any of them can.";
  }
}

function readHealthCandidates(value: unknown): HealthCandidate[] {
  const list = Array.isArray(value) ? value : [];
  return list.map((entry, index) => {
    const candidate = (entry && typeof entry === "object" ? entry : {}) as { spec?: { type?: unknown; url?: unknown }; confidence?: unknown; method?: unknown };
    return {
      index,
      type: typeof candidate.spec?.type === "string" ? candidate.spec.type : null,
      url: typeof candidate.spec?.url === "string" ? candidate.spec.url : null,
      confidence: typeof candidate.confidence === "number" && Number.isFinite(candidate.confidence) ? candidate.confidence : null,
      method: typeof candidate.method === "string" ? candidate.method : null,
    };
  });
}

/** The most items one page will render. The count beside the heading is the true total. */
export const HEALTH_ITEM_LIMIT = 100;

/**
 * Everything that needs this account, each with the rows its resolution is posted against.
 *
 * One item per company: a company is one subject, however many of its sources are unhappy. The
 * order of the tests below is the order of the resolutions — candidates somebody can pick beat a
 * board that is refusing us, which beats one that has no source at all — and it is the same union
 * `countHealthItems` counts in SQL, so the sidebar and the page cannot disagree.
 */
export async function healthItems(userId: string, now: Date = new Date()): Promise<HealthItem[]> {
  const [followed, budget] = await Promise.all([
    db()
      .select({ id: companies.id, name: companies.name })
      .from(companySubscriptions)
      .innerJoin(companies, eq(companies.id, companySubscriptions.companyId))
      .where(and(
        eq(companySubscriptions.userId, userId),
        eq(companySubscriptions.status, "active"),
        ne(companies.status, "archived"),
      ))
      .orderBy(asc(companies.name), companies.id),
    accountAiBudget(userId, now),
  ]);

  const items: HealthItem[] = [];
  // The account's own budget: not a company's problem, and the one item that stops every other
  // account's work too if it is not seen.
  if (budget.spentUsd >= budget.limitUsd) {
    items.push({
      key: "budget",
      kind: "budget",
      company: null,
      source: null,
      runId: null,
      candidates: [],
      reason: null,
      budget: { spentUsd: budget.spentUsd, limitUsd: budget.limitUsd },
    });
  }

  const ids = followed.map((company) => company.id);
  if (ids.length) {
    const [sourceRows, runRows] = await Promise.all([
      db()
        .select({
          id: careerSources.id,
          companyId: careerSources.companyId,
          type: careerSources.type,
          url: careerSources.url,
          status: careerSources.status,
          consecutiveFailures: careerSources.consecutiveFailures,
        })
        .from(careerSources)
        .where(inArray(careerSources.companyId, ids))
        .orderBy(asc(careerSources.createdAt)),
      db()
        .selectDistinctOn([discoveryRuns.companyId], {
          companyId: discoveryRuns.companyId,
          id: discoveryRuns.id,
          status: discoveryRuns.status,
          candidates: discoveryRuns.candidates,
        })
        .from(discoveryRuns)
        .where(inArray(discoveryRuns.companyId, ids))
        .orderBy(discoveryRuns.companyId, desc(discoveryRuns.startedAt)),
    ]);

    const runByCompany = new Map(runRows.map((row) => [row.companyId, row]));
    const found: Array<HealthItem & { sortName: string }> = [];
    for (const company of followed) {
      const sources = sourceRows.filter((source) => source.companyId === company.id);
      const unconfirmed = sources.find((source) => source.status === "needs_confirmation");
      const blocked = sources.find((source) => source.status === "blocked");
      const failing = sources.find((source) => source.status === "failing");
      const working = sources.some((source) => source.status === "active" || source.status === "failing");
      const run = runByCompany.get(company.id);
      const candidates = run?.status === "needs_confirmation" ? readHealthCandidates(run.candidates) : [];
      const proposal = candidates.length ? run : undefined;

      const base = { company: { id: company.id, name: company.name }, runId: null, candidates: [], reason: null, budget: null };
      const add = (kind: HealthItemKind, rest: Partial<HealthItem>) =>
        found.push({ key: `${kind}:${company.id}`, kind, source: null, ...base, ...rest, sortName: company.name });

      if (unconfirmed) add("needs_confirmation", { source: unconfirmed, runId: proposal?.id ?? null, candidates });
      else if (proposal && !working) add("needs_confirmation", { runId: proposal.id, candidates });
      else if (blocked) add("blocked", { source: blocked });
      else if (failing) add("failing", { source: failing });
      else if (!working) add("no_source", {});
      else if (proposal) add("rediscovery", { runId: proposal.id, candidates });
    }

    // What the worker last recorded about a board that is refusing us or failing, so the item
    // carries the reason rather than sending the reader to the scan history for it.
    const needReason = found.filter((item) => item.kind === "blocked" || item.kind === "failing").map((item) => item.source!.id);
    if (needReason.length) {
      const reasons = await db()
        .selectDistinctOn([scans.sourceId], { sourceId: scans.sourceId, error: scans.error })
        .from(scans)
        .where(inArray(scans.sourceId, needReason))
        .orderBy(scans.sourceId, desc(scans.startedAt));
      const bySource = new Map(reasons.map((row) => [row.sourceId, row.error]));
      for (const item of found) if (item.source) item.reason = bySource.get(item.source.id) ?? null;
    }

    found.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.sortName.localeCompare(b.sortName));
    for (const { sortName: _sortName, ...item } of found) items.push(item);
  }

  return items.slice(0, HEALTH_ITEM_LIMIT);
}

/**
 * How many items there are, for the sidebar. One statement, because every page in the interface
 * renders the sidebar: the union below is the same one `healthItems` walks company by company.
 * Beside it, in the same round trip, the account's budget, which is itself one statement.
 *
 * Kept for the request, so Health's own count reuses the sidebar's. It is keyed by account and
 * budget month, the only part of the clock the count depends on, so callers with their own `now`
 * share one answer.
 */
export function countHealthItems(userId: string, now: Date = new Date()): Promise<number> {
  return countHealthItemsForMonth(userId, aiBudgetWindowStart(now, null).getTime());
}

const countHealthItemsForMonth = cache(async (userId: string, monthStart: number): Promise<number> => {
  const [rows, budget] = await Promise.all([
    db().execute(sql`
      select count(*)::int as n
      from company_subscriptions cs
      join companies c on c.id = cs.company_id
      where cs.user_id = ${userId}
        and cs.status = 'active'
        and c.status <> 'archived'
        and (
          exists (select 1 from career_sources s where s.company_id = c.id and s.status in ('needs_confirmation', 'blocked', 'failing'))
          or not exists (select 1 from career_sources s where s.company_id = c.id and s.status in ('active', 'failing'))
          or exists (
            select 1 from discovery_runs r
            where r.company_id = c.id
              and r.status = 'needs_confirmation'
              and jsonb_array_length(r.candidates) > 0
              and r.started_at = (select max(r2.started_at) from discovery_runs r2 where r2.company_id = c.id)
          )
        )`),
    accountAiBudget(userId, new Date(monthStart)),
  ]);
  return Number(rows.rows[0]?.n ?? 0) + (budget.spentUsd >= budget.limitUsd ? 1 : 0);
});
