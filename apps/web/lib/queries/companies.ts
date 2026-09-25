import { latestApplicationFor, roleStageSql, roleStatusSql } from "@ava/db";
import { MANUAL_RESCAN_INTERVAL_MS } from "@ava/core";
import { and, asc, desc, eq, gte, inArray, isNotNull, ne, sql, getTableColumns, ilike, or, type SQL } from "drizzle-orm";
import { DEFAULT_COMPANY_SORT, type CompanySort, type CompanySortKey } from "@/lib/company-sort";
import {
  cvDrafts,
  decisions,
  careerSources,
  companies,
  companyNameSuggestions,
  companyProfiles,
  companySubscriptions,
  discoveryRuns,
  jobs,
  scanRuns,
  scans,
  tasks,
  userJobs,
  users,
  type CareerSource,
  type Company,
  type CompanyProfile,
  type CompanySubscription,
  type DiscoveryRun,
  type Scan,
  type Task,
} from "@ava/db/schema";
import { db } from "@/lib/db";
import type { CompanySetupRows, TimelineCandidate, TimelineTask } from "@/lib/company-timeline";

export interface CompanyListRow {
  company: Company;
  /** This account's relationship with the shared company: its own status and notes. */
  subscription: CompanySubscription;
  lastScan: { status: Scan["status"]; startedAt: Date } | null;
  /** Postings this account's gate admitted that are still open: what following the company is worth. */
  openRoles: number;
  reviewRoles: number;
  shortlistedRoles: number;
  /** The type of the source a scan reads, `active` preferred over `failing`; null when there is none. */
  sourceType: CareerSource["type"] | null;
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

/**
 * The Tracked companies table, fifty rows a page, sorted in SQL so every page agrees with the
 * next. The role counts are one grouped subquery joined to the page's rows, so a count column can
 * order the page as well as fill it; `sort` only ever comes from `parseCompanySort`'s whitelist.
 */
export async function listCompanies(userId: string, page = 1, q = "", order: CompanySort = DEFAULT_COMPANY_SORT): Promise<CompanyListRow[]> {
  const counts = db()
    .select({
      companyId: jobs.companyId,
      openRoles: sql<number>`count(*) filter (where ${userJobs.inTable} and ${userJobs.archivedAt} is null and ${jobs.status} = 'open')::int`.as("open_roles"),
      reviewRoles: sql<number>`count(*) filter (where ${roleStatusSql} = 'auto-matched')::int`.as("review_roles"),
      shortlistedRoles: sql<number>`count(*) filter (where ${roleStatusSql} = 'user-shortlisted')::int`.as("shortlisted_roles"),
    })
    .from(userJobs)
    .innerJoin(jobs, eq(jobs.id, userJobs.jobId))
    .leftJoin(decisions, and(eq(decisions.userId, userId), eq(decisions.jobId, jobs.id), eq(decisions.superseded, false)))
    .where(eq(userJobs.userId, userId))
    .groupBy(jobs.companyId)
    .as("role_counts");
  // Whitelisted expressions only. Source and last scan are read where the row reads them: the
  // oldest active source (a failing one when nothing is active), and the newest scan of any source.
  const sortExpressions: Record<CompanySortKey, SQL> = {
    company: sql`lower(${companies.name})`,
    source: sql`(select cs.type from career_sources cs where cs.company_id = ${companies.id} and cs.status in ('active', 'failing')
      order by (cs.status = 'active') desc, cs.created_at asc limit 1)`,
    status: sql`(select max(s.started_at) from scans s join career_sources cs on cs.id = s.source_id where cs.company_id = ${companies.id})`,
    open: sql`coalesce(${counts.openRoles}, 0)`,
    review: sql`coalesce(${counts.reviewRoles}, 0)`,
    shortlisted: sql`coalesce(${counts.shortlistedRoles}, 0)`,
  };
  const direction = order.dir === "desc" ? sql`desc` : sql`asc`;
  const followed = await db().select({
    company: companies,
    subscription: companySubscriptions,
    openRoles: counts.openRoles,
    reviewRoles: counts.reviewRoles,
    shortlistedRoles: counts.shortlistedRoles,
  }).from(companySubscriptions)
    .innerJoin(companies, eq(companies.id, companySubscriptions.companyId))
    .leftJoin(counts, eq(counts.companyId, companies.id))
    .where(and(eq(companySubscriptions.userId, userId), companySearch(q)))
    // A company with no source or no scan goes last whichever way the column runs.
    .orderBy(sql`${sortExpressions[order.sort]} ${direction} nulls last`, asc(companies.name), companies.id)
    .limit(50).offset((page - 1) * 50);
  if (!followed.length) return [];
  const ids = followed.map(c => c.company.id);
  const [lastScans, discoveringRows, sourceRows, discoveryRows, followerRows] = await Promise.all([
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
      .select({ companyId: careerSources.companyId, type: careerSources.type, status: careerSources.status })
      .from(careerSources)
      .where(and(inArray(careerSources.companyId, ids), inArray(careerSources.status, ["active", "failing"])))
      .orderBy(asc(careerSources.createdAt)),
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
  // The oldest `active` source names the row; a `failing` one only when nothing active is left,
  // so a board that has started refusing still says which board it is.
  const sourceTypeByCompany = new Map<string, { type: CareerSource["type"]; active: boolean }>();
  for (const row of sourceRows) {
    const current = sourceTypeByCompany.get(row.companyId);
    const active = row.status === "active";
    if (!current || (active && !current.active)) sourceTypeByCompany.set(row.companyId, { type: row.type, active });
  }
  const lastDiscoveryByCompany = new Map(discoveryRows.map((r) => [r.companyId, r.status]));
  const lastScanByCompany = new Map(lastScans.map((s) => [s.companyId, { status: s.status, startedAt: s.startedAt }]));
  const followersByCompany = new Map(followerRows.map((f) => [f.companyId, f.n]));
  const discoveringSet = new Set(
    discoveringRows.map((r) => (r.payload as { companyId?: string }).companyId).filter((id): id is string => !!id),
  );

  return followed.map(({ company, subscription, openRoles, reviewRoles, shortlistedRoles }) => ({
    company,
    subscription,
    lastScan: lastScanByCompany.get(company.id) ?? null,
    openRoles: Number(openRoles ?? 0),
    reviewRoles: Number(reviewRoles ?? 0),
    shortlistedRoles: Number(shortlistedRoles ?? 0),
    sourceType: sourceTypeByCompany.get(company.id)?.type ?? null,
    followers: followersByCompany.get(company.id) ?? 0,
    discovering: discoveringSet.has(company.id),
    discoveryState: discoveringRows.some(r => (r.payload as { companyId?: string }).companyId === company.id && r.status === "running") ? "running"
      : discoveringSet.has(company.id) ? "queued" : null,
    needsSource: !withSource.has(company.id),
    lastDiscovery: (lastDiscoveryByCompany.get(company.id) as CompanyListRow["lastDiscovery"]) ?? null,
  }));
}

/** One catalogue company found by the Discover tab's search, and where this account stands with it. */
export interface CatalogueMatch {
  id: string;
  name: string;
  domain: string;
  homepageUrl: string;
  faviconUrl: string | null;
  logoFetchedAt: Date | null;
  /** This account's subscription status; null when it has never followed the company. */
  followStatus: CompanySubscription["status"] | null;
}

export const CATALOGUE_SEARCH_LIMIT = 10;

/**
 * The shared catalogue by name or domain, for following a company someone already added. Archived
 * companies — nobody follows them — are left out: pasting the homepage still follows one through
 * `addCompanies`. Names that start with the query come first, then A–Z.
 */
export async function searchCatalogue(userId: string, q: string): Promise<CatalogueMatch[]> {
  const query = q.trim().slice(0, 200);
  if (!query) return [];
  const prefix = `${query.replace(/[\\%_]/g, "\\$&")}%`;
  return db()
    .select({
      id: companies.id,
      name: companies.name,
      domain: companies.domain,
      homepageUrl: companies.homepageUrl,
      faviconUrl: companies.faviconUrl,
      logoFetchedAt: companies.logoFetchedAt,
      followStatus: companySubscriptions.status,
    })
    .from(companies)
    .leftJoin(companySubscriptions, and(eq(companySubscriptions.companyId, companies.id), eq(companySubscriptions.userId, userId)))
    .where(and(ne(companies.status, "archived"), companySearch(query)))
    .orderBy(sql`(${companies.name} ilike ${prefix} or ${companies.domain} ilike ${prefix}) desc`, asc(companies.name), companies.id)
    .limit(CATALOGUE_SEARCH_LIMIT);
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

/**
 * Shared discovery queued or running for one company — the same task lookup the companies list
 * makes for a page of them, narrowed to one. Logo captures are excluded: they ride the discover
 * task but say nothing about whether a careers page is being looked for.
 */
export async function companyDiscoveryState(companyId: string): Promise<"queued" | "running" | null> {
  const rows = await db()
    .select({ status: tasks.status })
    .from(tasks)
    .where(and(
      eq(tasks.type, "discover"),
      sql`coalesce(${tasks.payload}->>'logoOnly', 'false') != 'true'`,
      inArray(tasks.status, ["queued", "running"]),
      sql`${tasks.payload}->>'companyId' = ${companyId}`,
    ));
  if (!rows.length) return null;
  return rows.some(row => row.status === "running") ? "running" : "queued";
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

/**
 * How many roles at one company this account is pursuing — the figure the company page links into
 * Applications with. The rule is `listPipeline`'s, so the two cannot disagree: everything past
 * Matched, and a dismissed role only when something was done about it (an application row, or a CV
 * whether archived or not). Records with no posting behind them have no company to count against
 * and are the Applications page's business alone.
 */
export async function companyApplicationCount(userId: string, companyId: string): Promise<number> {
  const latest = latestApplicationFor(userId);
  const stage = roleStageSql(latest, userId);
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(userJobs)
    .innerJoin(jobs, eq(jobs.id, userJobs.jobId))
    .leftJoin(decisions, and(eq(decisions.userId, userId), eq(decisions.jobId, jobs.id), eq(decisions.superseded, false)))
    .leftJoin(latest, eq(latest.jobId, jobs.id))
    .where(and(
      eq(userJobs.userId, userId),
      eq(jobs.companyId, companyId),
      ne(stage, "matched"),
      or(
        ne(stage, "dismissed"),
        isNotNull(latest.id),
        sql`exists (select 1 from ${cvDrafts} pursued where pursued.user_id = ${userId} and pursued.job_id = ${jobs.id})`,
      ),
    ));
  return row?.n ?? 0;
}

/** What the company header can say about scanning: when it last read the board, and whether the
 *  last rescan anyone asked for was served from that reading instead of running again. */
export interface CompanyScanTiming {
  /** The newest scan a rescan would be served from: `ok` or `partial`, whichever source ran it. */
  lastGoodScanAt: Date | null;
  /**
   * When the newest finished `scan_company` task returned `skipped: "scanned recently"`, while
   * that is still the answer: the task finished after the last good scan, and that scan is inside
   * the reuse window. Null otherwise, because no line reports an older skip.
   */
  rescanSkippedAt: Date | null;
}

/**
 * A scan is shared, so a follower's Rescan can finish having done nothing: the worker serves it
 * from a scan made in the last half hour and says so in the task's result. Both readings are of
 * the catalogue, not of one account — the company is scanned once for everyone.
 *
 * The last scan comes from `scans`, a few rows per source. Finished tasks are consulted only
 * inside the half hour after that scan, the only time a skip can be reported, and only those that
 * finished after it; the rest of the page's life never walks the retained task history.
 */
export async function companyScanTiming(companyId: string, now = new Date()): Promise<CompanyScanTiming> {
  const [scanRow] = await db()
    .select({ startedAt: scans.startedAt })
    .from(scans)
    .innerJoin(careerSources, eq(scans.sourceId, careerSources.id))
    .where(and(eq(careerSources.companyId, companyId), inArray(scans.status, ["ok", "partial"])))
    .orderBy(desc(scans.startedAt))
    .limit(1);
  const lastGoodScanAt = scanRow?.startedAt ?? null;
  if (!lastGoodScanAt || now.getTime() - lastGoodScanAt.getTime() >= MANUAL_RESCAN_INTERVAL_MS) return { lastGoodScanAt, rescanSkippedAt: null };
  const [taskRow] = await db()
    .select({ finishedAt: tasks.finishedAt, result: tasks.result })
    .from(tasks)
    .where(and(
      eq(tasks.type, "scan_company"),
      eq(tasks.status, "done"),
      sql`${tasks.payload}->>'companyId' = ${companyId}`,
      gte(tasks.finishedAt, lastGoodScanAt),
    ))
    .orderBy(desc(tasks.finishedAt))
    .limit(1);
  const result = taskRow?.result as { skipped?: unknown } | null | undefined;
  const skipped = !!result && typeof result === "object" && result.skipped === "scanned recently";
  return { lastGoodScanAt, rescanSkippedAt: skipped ? taskRow?.finishedAt ?? null : null };
}

/**
 * Everything the setup timeline says, gathered for one company and one account.
 *
 * The catalogue half — the discovery run, the work in flight, the source a scan reads and that
 * source's newest scan — is shared by every follower. The last figure is not: what a board came to
 * is this account's own `user_jobs`, which is why the read carries a `userId` like every other
 * per-account read. The rows go to `narrateCompanySetup`, which turns them into lines.
 */
export async function companySetupRows(userId: string, companyId: string): Promise<CompanySetupRows> {
  const [run, taskRows, sourceRows, counts] = await Promise.all([
    getLatestDiscoveryRun(companyId),
    // Logo captures ride the `discover` task and say nothing about a careers page, so they are
    // left out here exactly as `companyDiscoveryState` leaves them out.
    db()
      .select({ type: tasks.type, status: tasks.status, startedAt: tasks.startedAt })
      .from(tasks)
      .where(and(
        inArray(tasks.type, ["discover", "scan_company"]),
        sql`coalesce(${tasks.payload}->>'logoOnly', 'false') != 'true'`,
        inArray(tasks.status, ["queued", "running"]),
        sql`${tasks.payload}->>'companyId' = ${companyId}`,
      )),
    db()
      .select({
        id: careerSources.id,
        type: careerSources.type,
        url: careerSources.url,
        status: careerSources.status,
        confidence: careerSources.confidence,
        confirmedByUser: careerSources.confirmedByUser,
        consecutiveFailures: careerSources.consecutiveFailures,
      })
      .from(careerSources)
      .where(and(eq(careerSources.companyId, companyId), inArray(careerSources.status, ["active", "failing"])))
      .orderBy(asc(careerSources.createdAt)),
    db()
      .select({
        inTable: sql<number>`count(*) filter (where ${userJobs.inTable} and ${userJobs.archivedAt} is null and ${jobs.status} = 'open')::int`,
        scoring: sql<number>`count(*) filter (where ${userJobs.scoreState} = 'queued' and ${userJobs.archivedAt} is null)::int`,
        scored: sql<number>`count(*) filter (where ${userJobs.inTable} and ${userJobs.archivedAt} is null and ${jobs.status} = 'open' and ${userJobs.fitScore} is not null)::int`,
      })
      .from(userJobs)
      .innerJoin(jobs, eq(jobs.id, userJobs.jobId))
      .where(and(eq(userJobs.userId, userId), eq(jobs.companyId, companyId))),
  ]);

  // The oldest `active` source names the timeline; a `failing` one only when nothing active is
  // left, which is the rule the companies list already follows.
  const source = sourceRows.find((row) => row.status === "active") ?? sourceRows[0] ?? null;
  const [scan] = source
    ? await db()
        .select({
          status: scans.status,
          startedAt: scans.startedAt,
          postingsFound: scans.postingsFound,
          error: scans.error,
          durationMs: scans.durationMs,
        })
        .from(scans)
        .where(eq(scans.sourceId, source.id))
        .orderBy(desc(scans.startedAt))
        .limit(1)
    : [];

  const task = (type: Task["type"]): TimelineTask | null => {
    const rows = taskRows.filter((row) => row.type === type);
    const active = rows.find((row) => row.status === "running") ?? rows[0];
    return active ? { state: active.status === "running" ? "running" : "queued", startedAt: active.startedAt } : null;
  };

  return {
    run: run
      ? {
          status: run.status,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          candidates: (run.candidates ?? []).map(readCandidate),
          chosenSourceId: run.chosenSourceId,
          error: run.error,
        }
      : null,
    discoveryTask: task("discover"),
    source,
    scan: scan ?? null,
    scanTask: task("scan_company"),
    table: { inTable: counts[0]?.inTable ?? 0, scoring: counts[0]?.scoring ?? 0, scored: counts[0]?.scored ?? 0 },
  };
}

/** One stored candidate, read defensively: the column is jsonb written by an older release. */
function readCandidate(value: unknown): TimelineCandidate {
  const candidate = (value && typeof value === "object" ? value : {}) as { spec?: { type?: unknown; url?: unknown }; confidence?: unknown };
  return {
    type: typeof candidate.spec?.type === "string" ? candidate.spec.type : null,
    url: typeof candidate.spec?.url === "string" ? candidate.spec.url : null,
    confidence: typeof candidate.confidence === "number" && Number.isFinite(candidate.confidence) ? candidate.confidence : null,
  };
}

/** How many other accounts follow a company: shown before someone edits its shared details. */
export async function companyFollowerCount(companyId: string): Promise<number> {
  const [row] = await db().select({ n: sql<number>`count(*)::int` }).from(companySubscriptions)
    .where(and(eq(companySubscriptions.companyId, companyId), ne(companySubscriptions.status, "archived")));
  return row?.n ?? 0;
}


// ---------------------------------------------------------------------------
// Roles a follower added by URL, and the imports still in flight
// ---------------------------------------------------------------------------

/** What the worker hands back for an `import_posting` task. Data, checked before it is read. */
export interface ImportPostingResult {
  ok: boolean;
  reason?: string;
  jobId?: string;
  title?: string;
  existing?: boolean;
  gate?: { inTable: boolean; keywordMatched: boolean; locationOk: boolean; excluded: boolean; keywordTerms: string[] };
}

export interface PostingImportRow {
  id: string;
  status: Task["status"];
  url: string;
  createdAt: Date;
  error: string | null;
  result: ImportPostingResult | null;
}

const IMPORT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * This account's recent imports for one company, newest first. Tasks are pruned, so this is the
 * short-lived report on work in flight; the roles themselves outlive it (see `ungatedUserPostings`).
 */
export async function recentPostingImports(userId: string, companyId: string, limit = 5, now = new Date()): Promise<PostingImportRow[]> {
  const rows = await db()
    .select({ id: tasks.id, status: tasks.status, payload: tasks.payload, createdAt: tasks.createdAt, error: tasks.error, result: tasks.result })
    .from(tasks)
    .where(and(
      eq(tasks.type, "import_posting"),
      sql`${tasks.payload}->>'userId' = ${userId}`,
      sql`${tasks.payload}->>'companyId' = ${companyId}`,
      sql`${tasks.createdAt} >= ${new Date(now.getTime() - IMPORT_WINDOW_MS)}`,
    ))
    .orderBy(desc(tasks.createdAt))
    .limit(limit);
  return rows.map(row => ({
    id: row.id,
    status: row.status,
    url: String((row.payload as { url?: unknown }).url ?? ""),
    createdAt: row.createdAt,
    error: row.error,
    result: row.result && typeof row.result === "object" ? (row.result as ImportPostingResult) : null,
  }));
}

export interface UserAddedRole {
  jobId: string;
  title: string;
  url: string;
  keywordMatched: boolean;
  locationOk: boolean;
  excluded: boolean;
}

/**
 * Roles this account added by URL that its own gate would have refused. They are in the table
 * because they were asked for, and they are listed apart so the prompt to widen the keywords
 * outlives the task that first showed it.
 */
export async function ungatedUserPostings(userId: string, companyId: string): Promise<UserAddedRole[]> {
  return db()
    .select({ jobId: jobs.id, title: jobs.title, url: jobs.url, keywordMatched: userJobs.keywordMatched, locationOk: userJobs.locationOk, excluded: userJobs.excluded })
    .from(jobs)
    .innerJoin(userJobs, and(eq(userJobs.jobId, jobs.id), eq(userJobs.userId, userId)))
    .where(and(
      eq(jobs.companyId, companyId),
      eq(jobs.origin, "user"),
      eq(jobs.addedBy, userId),
      eq(jobs.status, "open"),
      or(eq(userJobs.keywordMatched, false), eq(userJobs.locationOk, false), eq(userJobs.excluded, true)),
    ))
    .orderBy(desc(jobs.firstSeenAt), jobs.id)
    .limit(50);
}

// ---------------------------------------------------------------------------
// Name suggestions
// ---------------------------------------------------------------------------

/** This account's own pending proposal for a company's name, if it made one. */
export async function pendingNameSuggestion(userId: string, companyId: string): Promise<{ id: string; name: string } | null> {
  const [row] = await db()
    .select({ id: companyNameSuggestions.id, name: companyNameSuggestions.name })
    .from(companyNameSuggestions)
    .where(and(eq(companyNameSuggestions.userId, userId), eq(companyNameSuggestions.companyId, companyId), eq(companyNameSuggestions.status, "pending")))
    .limit(1);
  return row ?? null;
}

export interface NameSuggestionRow {
  id: string;
  companyId: string;
  name: string;
  email: string;
  createdAt: Date;
}

/** Every pending proposal for a page of the catalogue, for the administrator who resolves them. */
export async function pendingNameSuggestionsFor(companyIds: string[]): Promise<NameSuggestionRow[]> {
  if (!companyIds.length) return [];
  return db()
    .select({ id: companyNameSuggestions.id, companyId: companyNameSuggestions.companyId, name: companyNameSuggestions.name, email: users.email, createdAt: companyNameSuggestions.createdAt })
    .from(companyNameSuggestions)
    .innerJoin(users, eq(users.id, companyNameSuggestions.userId))
    .where(and(inArray(companyNameSuggestions.companyId, companyIds), eq(companyNameSuggestions.status, "pending")))
    .orderBy(desc(companyNameSuggestions.createdAt));
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
