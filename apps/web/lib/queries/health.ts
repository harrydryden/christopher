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
} from "@christopher/db";
import {
  cvBuildSteps,
  cvDrafts,
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
} from "@christopher/db/schema";
// The deadline table lives in packages/core so the interface can say how long a running task has
// left without importing the worker.
import { deadlineFor } from "@christopher/core";
import { groupAiUsage, type AiUsageGroup } from "@/lib/ai-usage";
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
  return ifLedger(() => costPerCvBuild(db(), limit), { builds: [], medianUsd: null, worstUsd: null, stages: [] });
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

const isoDate = (value: unknown): Date | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value) : null;
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
  return rows.map((row, i) => ({
    id: row.id,
    at: row.at,
    kind: row.kind,
    workerId: row.workerId,
    taskType: row.taskType,
    subject: subjectName(refs[i] ?? null, names),
    detail: eventDetailLine(row.kind, row.detail ?? {}),
  }));
}

/** The most recent crash recovery, with the tasks the dead process was holding. */
export async function getLastCrashRecovery(): Promise<CrashRecovery | null> {
  const [row] = await ifLedger(
    () => listWorkerEvents(db(), { kinds: ["crash_recovery"], limit: 1 }),
    [] as Awaited<ReturnType<typeof listWorkerEvents>>,
  );
  if (!row) return null;
  const detail = row.detail ?? {};
  const names = await resolveSubjects(crashSuspectRefs(detail));
  return { at: row.at, workerId: row.workerId, suspects: readSuspects(detail, names) };
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
    startedAt: row.startedAt,
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
  return rows.map((row, i) => ({
    id: row.id,
    type: row.type,
    subject: subjectName(refs[i] ?? null, names),
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    error: row.error,
    runAfter: row.runAfter,
  }));
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
  return rows.map((row) => ({
    sourceId: row.sourceId,
    companyId: row.companyId,
    companyName: row.companyName,
    sourceType: row.sourceType,
    bytes: Number(row.bytes ?? 0),
    fetchMethod: row.fetchMethod,
    requests: row.requests === null ? null : Number(row.requests),
    revalidated: row.revalidated === null ? null : Number(row.revalidated),
    at: row.at,
  }));
}

export { companySubscriptions as _companySubscriptions, workerEvents as _workerEvents };
