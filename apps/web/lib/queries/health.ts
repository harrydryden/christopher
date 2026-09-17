import { scanRunReport } from "@/lib/scan-run-report";
import { and, desc, eq, gte, inArray, ne, sql, getTableColumns } from "drizzle-orm";
import { aiUsageByAccount, sharedAiSpend } from "@christopher/db";
import {
  settings,
  careerSources,
  companies,
  companySubscriptions,
  scanRuns,
  scans,
  tasks,
  type CareerSource,
  type Task,
} from "@christopher/db/schema";
import { groupAiUsage, type AiUsageGroup } from "@/lib/ai-usage";
import { db } from "@/lib/db";

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
 * Everything spent since `since`, whoever it was for: what the deployment's shared ceiling counts.
 * The window starts at the start of the UTC month, or later if the shared counter was reset;
 * `aiBudgetWindowStart` decides, so this takes the instant rather than working it out again.
 */
export async function getSharedAiSpend(since: Date): Promise<number> {
  return sharedAiSpend(db(), since);
}

/** The operations report: one line per account, feature and model since `since`, dearest first. */
export async function getAiUsage(since: Date): Promise<AiUsageGroup[]> {
  return groupAiUsage(await aiUsageByAccount(db(), since));
}

export async function listRecentScanRuns(limit = 10, userId?: string) {
  const runs = await db().select().from(scanRuns).orderBy(desc(scanRuns.startedAt)).limit(limit);
  return Promise.all(runs.map((run) => scanRunReport(run, userId)));
}

/** Last report from the persistent worker; configuration is not a successful API probe. */
export async function getWorkerHeartbeat() {
  const [row] = await db().select({ value: settings.value }).from(settings)
    .where(eq(settings.key, "internal:workerHeartbeat")).limit(1);
  const value = row?.value as { at?: unknown; aiConfigured?: unknown; browserAvailable?: unknown; commit?: unknown } | undefined;
  if (!value || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at))) return null;
  return { commit: typeof value.commit === "string" && /^[a-f0-9]{40}$/.test(value.commit) ? value.commit : null, at: new Date(value.at), aiConfigured: value.aiConfigured === true, browserAvailable: value.browserAvailable === true };
}

export { companySubscriptions as _companySubscriptions };
