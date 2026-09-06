import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
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
  type Job,
  type Scan,
} from "@christopher/db/schema";
import { db } from "@/lib/db";

export interface CompanyListRow {
  company: Company;
  sources: CareerSource[];
  lastScan: { status: Scan["status"]; startedAt: Date } | null;
  openRoles: number;
  inTableRoles: number;
  discovering: boolean;
  discoveryState: "queued" | "running" | null;
}

export async function listCompanies(): Promise<CompanyListRow[]> {
  const [allCompanies, allSources, counts, lastScans, discoveringRows] = await Promise.all([
    db().select().from(companies).orderBy(asc(companies.name)),
    db().select().from(careerSources).orderBy(asc(careerSources.createdAt)),
    db()
      .select({
        companyId: jobs.companyId,
        openRoles: sql<number>`count(*) filter (where ${jobs.status} = 'open')::int`,
        inTableRoles: sql<number>`count(*) filter (where ${jobs.inTable} = true and ${jobs.archivedAt} is null)::int`,
      })
      .from(jobs)
      .groupBy(jobs.companyId),
    db()
      .selectDistinctOn([careerSources.companyId], {
        companyId: careerSources.companyId,
        status: scans.status,
        startedAt: scans.startedAt,
      })
      .from(scans)
      .innerJoin(careerSources, eq(scans.sourceId, careerSources.id))
      .orderBy(careerSources.companyId, desc(scans.startedAt)),
    db()
      .select({ payload: tasks.payload, status: tasks.status })
      .from(tasks)
      .where(and(eq(tasks.type, "discover"), inArray(tasks.status, ["queued", "running"]))),
  ]);

  const sourcesByCompany = new Map<string, CareerSource[]>();
  for (const s of allSources) {
    const list = sourcesByCompany.get(s.companyId) ?? [];
    list.push(s);
    sourcesByCompany.set(s.companyId, list);
  }
  const countsByCompany = new Map(counts.map((c) => [c.companyId, c]));
  const lastScanByCompany = new Map(lastScans.map((s) => [s.companyId, { status: s.status, startedAt: s.startedAt }]));
  const discoveringSet = new Set(
    discoveringRows.map((r) => (r.payload as { companyId?: string }).companyId).filter((id): id is string => !!id),
  );

  return allCompanies.map((company) => ({
    company,
    sources: sourcesByCompany.get(company.id) ?? [],
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

export interface CompanyScanRow extends Scan {
  sourceType: CareerSource["type"];
  sourceUrl: string;
}

export async function getCompanyScans(companyId: string, limit = 20): Promise<CompanyScanRow[]> {
  const rows = await db()
    .select({ scan: scans, sourceType: careerSources.type, sourceUrl: careerSources.url })
    .from(scans)
    .innerJoin(careerSources, eq(scans.sourceId, careerSources.id))
    .where(eq(careerSources.companyId, companyId))
    .orderBy(desc(scans.startedAt))
    .limit(limit);
  return rows.map((r) => ({ ...r.scan, sourceType: r.sourceType, sourceUrl: r.sourceUrl }));
}

export async function getCompanyRoles(companyId: string): Promise<Job[]> {
  return db().select().from(jobs).where(eq(jobs.companyId, companyId)).orderBy(desc(jobs.firstSeenAt));
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
