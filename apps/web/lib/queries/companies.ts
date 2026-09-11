import { and, asc, desc, eq, inArray, ne, sql, getTableColumns, ilike, or } from "drizzle-orm";
import {
  careerSources,
  companies,
  companyProfiles,
  discoveryRuns,
  jobs,
  scanRuns,
  scans,
  tasks,
  type CareerSource,
  type Company,
  type CompanyProfile,
  type DiscoveryRun,
  type Scan,
} from "@christopher/db/schema";
import { db } from "@/lib/db";

export interface CompanyListRow {
  company: Company;
  lastScan: { status: Scan["status"]; startedAt: Date } | null;
  openRoles: number;
  inTableRoles: number;
  discovering: boolean;
  discoveryState: "queued" | "running" | null;
}

export async function companyCount(q = ""): Promise<number> {
  const [row] = await db().select({ n: sql<number>`count(*)::int` }).from(companies).where(companySearch(q));
  return row?.n ?? 0;
}
function companySearch(q: string) {
  const escaped = q.slice(0, 200).replace(/[\\%_]/g, "\\$&");
  return q ? or(ilike(companies.name, `%${escaped}%`), ilike(companies.domain, `%${escaped}%`)) : undefined;
}

export async function listCompanies(page = 1, q = ""): Promise<CompanyListRow[]> {
  const allCompanies = await db().select().from(companies).where(companySearch(q)).orderBy(asc(companies.name), companies.id).limit(50).offset((page - 1) * 50);
  if (!allCompanies.length) return [];
  const ids = allCompanies.map(c => c.id);
  const [counts, lastScans, discoveringRows] = await Promise.all([
    db()
      .select({
        companyId: jobs.companyId,
        openRoles: sql<number>`count(*) filter (where ${jobs.status} = 'open')::int`,
        inTableRoles: sql<number>`count(*) filter (where ${jobs.inTable} = true and ${jobs.archivedAt} is null)::int`,
      })
      .from(jobs)
      .where(inArray(jobs.companyId, ids))
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
  ]);

  const countsByCompany = new Map(counts.map((c) => [c.companyId, c]));
  const lastScanByCompany = new Map(lastScans.map((s) => [s.companyId, { status: s.status, startedAt: s.startedAt }]));
  const discoveringSet = new Set(
    discoveringRows.map((r) => (r.payload as { companyId?: string }).companyId).filter((id): id is string => !!id),
  );

  return allCompanies.map((company) => ({
    company,
    lastScan: lastScanByCompany.get(company.id) ?? null,
    openRoles: countsByCompany.get(company.id)?.openRoles ?? 0,
    inTableRoles: countsByCompany.get(company.id)?.inTableRoles ?? 0,
    discovering: discoveringSet.has(company.id),
    discoveryState: discoveringRows.some(r => (r.payload as { companyId?: string }).companyId === company.id && r.status === "running") ? "running"
      : discoveringSet.has(company.id) ? "queued" : null,
  }));
}

export async function listCompanyOptions(): Promise<Array<{ id: string; name: string }>> {
  const rows = await db()
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(ne(companies.status, "archived"))
    .orderBy(asc(companies.name));
  return rows;
}

export async function listActiveDomains(): Promise<Set<string>> {
  const rows = await db().select({ domain: companies.domain }).from(companies);
  return new Set(rows.map((r) => r.domain));
}

export async function getCompany(id: string): Promise<Company | null> {
  const rows = await db().select().from(companies).where(eq(companies.id, id)).limit(1);
  return rows[0] ?? null;
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

export async function getCompanyRoles(companyId: string, page = 1) {
  return db().select({ id: jobs.id, title: jobs.title, url: jobs.url, location: jobs.location,
    postedAt: jobs.postedAt, status: jobs.status, firstSeenAt: jobs.firstSeenAt, closedAt: jobs.closedAt, seeded: jobs.seeded,
    inTable: jobs.inTable, nearMiss: jobs.nearMiss, fitScore: jobs.fitScore }).from(jobs).where(eq(jobs.companyId, companyId)).orderBy(desc(jobs.firstSeenAt), jobs.id).limit(50).offset((page - 1) * 50);
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

export async function companyRoleCount(companyId: string) {
  const [row] = await db().select({ n: sql<number>`count(*)::int` }).from(jobs).where(eq(jobs.companyId, companyId));
  return row?.n ?? 0;
}
