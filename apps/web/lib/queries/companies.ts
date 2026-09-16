import { roleStatusSql } from "@christopher/db";
import { and, asc, desc, eq, inArray, ne, sql, getTableColumns, ilike, or } from "drizzle-orm";
import {
  decisions,
  careerSources,
  companies,
  companyProfiles,
  companySubscriptions,
  discoveryRuns,
  jobs,
  scanRuns,
  scans,
  tasks,
  userJobs,
  type CareerSource,
  type Company,
  type CompanyProfile,
  type CompanySubscription,
  type DiscoveryRun,
  type Scan,
} from "@christopher/db/schema";
import { db } from "@/lib/db";

export interface CompanyListRow {
  company: Company;
  /** This account's relationship with the shared company: its own status and notes. */
  subscription: CompanySubscription;
  lastScan: { status: Scan["status"]; startedAt: Date } | null;
  reviewRoles: number;
  shortlistedRoles: number;
  /** How many accounts follow the company: a shared catalogue entry is scanned once for all of them. */
  followers: number;
  discovering: boolean;
  discoveryState: "queued" | "running" | null;
  /** No active or failing careers source, so scans skip this company until one is added. */
  needsSource: boolean;
  lastDiscovery: "resolved" | "needs_confirmation" | "not_found" | "failed" | "running" | null;
}

export async function companyCount(userId: string, q = ""): Promise<number> {
  const [row] = await db().select({ n: sql<number>`count(*)::int` }).from(companySubscriptions)
    .innerJoin(companies, eq(companies.id, companySubscriptions.companyId))
    .where(and(eq(companySubscriptions.userId, userId), companySearch(q)));
  return row?.n ?? 0;
}
function companySearch(q: string) {
  const escaped = q.slice(0, 200).replace(/[\\%_]/g, "\\$&");
  return q ? or(ilike(companies.name, `%${escaped}%`), ilike(companies.domain, `%${escaped}%`)) : undefined;
}

export async function listCompanies(userId: string, page = 1, q = ""): Promise<CompanyListRow[]> {
  const followed = await db().select({ company: companies, subscription: companySubscriptions }).from(companySubscriptions)
    .innerJoin(companies, eq(companies.id, companySubscriptions.companyId))
    .where(and(eq(companySubscriptions.userId, userId), companySearch(q)))
    .orderBy(asc(companies.name), companies.id).limit(50).offset((page - 1) * 50);
  if (!followed.length) return [];
  const ids = followed.map(c => c.company.id);
  const [counts, lastScans, discoveringRows, sourceRows, discoveryRows, followerRows] = await Promise.all([
    db()
      .select({
        companyId: jobs.companyId,
        reviewRoles: sql<number>`count(*) filter (where ${roleStatusSql} = 'auto-matched')::int`,
        shortlistedRoles: sql<number>`count(*) filter (where ${roleStatusSql} = 'user-shortlisted')::int`,
      })
      .from(userJobs)
      .innerJoin(jobs, eq(jobs.id, userJobs.jobId))
      .leftJoin(decisions, and(eq(decisions.userId, userId), eq(decisions.jobId, jobs.id), eq(decisions.superseded, false)))
      .where(and(eq(userJobs.userId, userId), inArray(jobs.companyId, ids)))
      .groupBy(jobs.companyId),
    db()
      .selectDistinctOn([careerSources.companyId], {
        companyId: careerSources.companyId,
        status: scans.status,
        startedAt: scans.startedAt,
      })
      .from(scans)
      .innerJoin(careerSources, eq(scans.sourceId, careerSources.id))
      .where(inArray(careerSources.companyId, ids))
      .orderBy(careerSources.companyId, desc(scans.startedAt)),
    db()
      .select({ payload: tasks.payload, status: tasks.status })
      .from(tasks)
      .where(and(inArray(tasks.type, ["discover", "scan_company"]), sql`coalesce(${tasks.payload}->>'logoOnly', 'false') != 'true'`, inArray(tasks.status, ["queued", "running"]), inArray(sql`${tasks.payload}->>'companyId'`, ids))),
    db()
      .select({ companyId: careerSources.companyId })
      .from(careerSources)
      .where(and(inArray(careerSources.companyId, ids), inArray(careerSources.status, ["active", "failing"]))),
    db()
      .selectDistinctOn([discoveryRuns.companyId], { companyId: discoveryRuns.companyId, status: discoveryRuns.status })
      .from(discoveryRuns)
      .where(inArray(discoveryRuns.companyId, ids))
      .orderBy(discoveryRuns.companyId, desc(discoveryRuns.startedAt)),
    db()
      .select({ companyId: companySubscriptions.companyId, n: sql<number>`count(*)::int` })
      .from(companySubscriptions)
      .where(and(inArray(companySubscriptions.companyId, ids), ne(companySubscriptions.status, "archived")))
      .groupBy(companySubscriptions.companyId),
  ]);

  const withSource = new Set(sourceRows.map((r) => r.companyId));
  const lastDiscoveryByCompany = new Map(discoveryRows.map((r) => [r.companyId, r.status]));
  const countsByCompany = new Map(counts.map((c) => [c.companyId, c]));
  const lastScanByCompany = new Map(lastScans.map((s) => [s.companyId, { status: s.status, startedAt: s.startedAt }]));
  const followersByCompany = new Map(followerRows.map((f) => [f.companyId, f.n]));
  const discoveringSet = new Set(
    discoveringRows.map((r) => (r.payload as { companyId?: string }).companyId).filter((id): id is string => !!id),
  );

  return followed.map(({ company, subscription }) => ({
    company,
    subscription,
    lastScan: lastScanByCompany.get(company.id) ?? null,
    reviewRoles: countsByCompany.get(company.id)?.reviewRoles ?? 0,
    shortlistedRoles: countsByCompany.get(company.id)?.shortlistedRoles ?? 0,
    followers: followersByCompany.get(company.id) ?? 0,
    discovering: discoveringSet.has(company.id),
    discoveryState: discoveringRows.some(r => (r.payload as { companyId?: string }).companyId === company.id && r.status === "running") ? "running"
      : discoveringSet.has(company.id) ? "queued" : null,
    needsSource: !withSource.has(company.id),
    lastDiscovery: (lastDiscoveryByCompany.get(company.id) as CompanyListRow["lastDiscovery"]) ?? null,
  }));
}

export async function listCompanyOptions(userId: string): Promise<Array<{ id: string; name: string }>> {
  const rows = await db()
    .select({ id: companies.id, name: companies.name })
    .from(companySubscriptions)
    .innerJoin(companies, eq(companies.id, companySubscriptions.companyId))
    .where(and(eq(companySubscriptions.userId, userId), ne(companySubscriptions.status, "archived")))
    .orderBy(asc(companies.name));
  return rows;
}

/** A company this account follows, with its subscription; null when it does not follow it. */
export async function getCompany(userId: string, id: string): Promise<(Company & { subscription: CompanySubscription }) | null> {
  const rows = await db().select({ company: companies, subscription: companySubscriptions }).from(companySubscriptions)
    .innerJoin(companies, eq(companies.id, companySubscriptions.companyId))
    .where(and(eq(companySubscriptions.userId, userId), eq(companySubscriptions.companyId, id))).limit(1);
  const row = rows[0];
  return row ? { ...row.company, subscription: row.subscription } : null;
}

export async function getCompanySources(companyId: string): Promise<CareerSource[]> {
  return db().select().from(careerSources).where(eq(careerSources.companyId, companyId)).orderBy(asc(careerSources.createdAt));
}

export async function getLatestDiscoveryRun(companyId: string): Promise<DiscoveryRun | null> {
  const rows = await db()
    .select()
    .from(discoveryRuns)
    .where(eq(discoveryRuns.companyId, companyId))
    .orderBy(desc(discoveryRuns.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

export interface CompanyScanRow extends Omit<Scan, "rawSnapshot"> {
  sourceType: CareerSource["type"];
  sourceUrl: string;
}

export async function getCompanyScans(companyId: string, limit = 20): Promise<CompanyScanRow[]> {
  const { rawSnapshot: _snapshot, ...scanFields } = getTableColumns(scans);
  const rows = await db()
    .select({ scan: scanFields, sourceType: careerSources.type, sourceUrl: careerSources.url })
    .from(scans)
    .innerJoin(careerSources, eq(scans.sourceId, careerSources.id))
    .where(eq(careerSources.companyId, companyId))
    .orderBy(desc(scans.startedAt))
    .limit(limit);
  return rows.map((r) => ({ ...r.scan, sourceType: r.sourceType, sourceUrl: r.sourceUrl }));
}

export async function getCompanyProfile(companyId: string): Promise<CompanyProfile | null> {
  const rows = await db()
    .select()
    .from(companyProfiles)
    .where(eq(companyProfiles.companyId, companyId))
    .orderBy(desc(companyProfiles.generatedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function getLatestScanRun(): Promise<
  (typeof scanRuns.$inferSelect) | null
> {
  const rows = await db().select().from(scanRuns).orderBy(desc(scanRuns.startedAt)).limit(1);
  return rows[0] ?? null;
}

/** How many other accounts follow a company: shown before someone edits its shared details. */
export async function companyFollowerCount(companyId: string): Promise<number> {
  const [row] = await db().select({ n: sql<number>`count(*)::int` }).from(companySubscriptions)
    .where(and(eq(companySubscriptions.companyId, companyId), ne(companySubscriptions.status, "archived")));
  return row?.n ?? 0;
}

/** The whole shared catalogue, for the administrator's section. */
export interface CatalogueRow {
  company: Company;
  followers: number;
  followedByViewer: boolean;
  sources: Array<Pick<CareerSource, "id" | "type" | "url" | "status" | "confirmedByUser">>;
  lastScan: { status: Scan["status"]; startedAt: Date } | null;
}

export async function catalogueCount(q = ""): Promise<number> {
  const [row] = await db().select({ n: sql<number>`count(*)::int` }).from(companies).where(companySearch(q));
  return row?.n ?? 0;
}

export async function listCatalogue(viewerId: string, page = 1, q = ""): Promise<CatalogueRow[]> {
  const rows = await db().select().from(companies).where(companySearch(q)).orderBy(asc(companies.name), companies.id).limit(50).offset((page - 1) * 50);
  if (!rows.length) return [];
  const ids = rows.map((c) => c.id);
  const [followerRows, viewerRows, sourceRows, lastScans] = await Promise.all([
    db()
      .select({ companyId: companySubscriptions.companyId, n: sql<number>`count(*)::int` })
      .from(companySubscriptions)
      .where(and(inArray(companySubscriptions.companyId, ids), ne(companySubscriptions.status, "archived")))
      .groupBy(companySubscriptions.companyId),
    db()
      .select({ companyId: companySubscriptions.companyId })
      .from(companySubscriptions)
      .where(and(eq(companySubscriptions.userId, viewerId), inArray(companySubscriptions.companyId, ids))),
    db()
      .select({ id: careerSources.id, companyId: careerSources.companyId, type: careerSources.type, url: careerSources.url, status: careerSources.status, confirmedByUser: careerSources.confirmedByUser })
      .from(careerSources)
      .where(inArray(careerSources.companyId, ids))
      .orderBy(asc(careerSources.createdAt)),
    db()
      .selectDistinctOn([careerSources.companyId], { companyId: careerSources.companyId, status: scans.status, startedAt: scans.startedAt })
      .from(scans)
      .innerJoin(careerSources, eq(scans.sourceId, careerSources.id))
      .where(inArray(careerSources.companyId, ids))
      .orderBy(careerSources.companyId, desc(scans.startedAt)),
  ]);
  const followers = new Map(followerRows.map((r) => [r.companyId, r.n]));
  const viewer = new Set(viewerRows.map((r) => r.companyId));
  const lastScan = new Map(lastScans.map((s) => [s.companyId, { status: s.status, startedAt: s.startedAt }]));
  return rows.map((company) => ({
    company,
    followers: followers.get(company.id) ?? 0,
    followedByViewer: viewer.has(company.id),
    sources: sourceRows.filter((s) => s.companyId === company.id).map(({ companyId: _companyId, ...source }) => source),
    lastScan: lastScan.get(company.id) ?? null,
  }));
}
