import { getTableColumns, and, desc, eq, inArray, ne, isNull, isNotNull, sql, lte } from "drizzle-orm";
import { careerSources, companies, decisions, jobEvents, jobs, type Job, type SourceType } from "@christopher/db/schema";
import { displayStatus, formatDuration, liveFor, type AppSettings, type DisplayStatus } from "@christopher/core";
import { db } from "@/lib/db";
import { eventTypeLabel, relativeTime } from "@/lib/format";

export interface RoleCompany {
  id: string;
  name: string;
  faviconUrl: string | null;
  homepageUrl: string;
  domain: string;
}

export interface RoleDecision {
  id: string;
  decision: "apply" | "skip";
  reason: string;
  tags: string[];
  createdAt: Date;
}

export interface RoleEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  at: Date;
}

export interface RoleRow {
  job: Job;
  company: RoleCompany;
  sourceType: SourceType;
  decision: RoleDecision | null;
  events: RoleEvent[];
}

const roleRowSelection = {
  job: jobs,
  company: {
    id: companies.id,
    name: companies.name,
    faviconUrl: companies.faviconUrl,
    homepageUrl: companies.homepageUrl,
    domain: companies.domain,
  },
  sourceType: careerSources.type,
  decision: {
    id: decisions.id,
    decision: decisions.decision,
    reason: decisions.reason,
    tags: decisions.tags,
    createdAt: decisions.createdAt,
  },
} as const;

function baseRolesSelect(summary = false) {
  return db()
    .select({ ...roleRowSelection, job: { ...getTableColumns(jobs), descriptionText: summary ? sql<string | null>`null` : jobs.descriptionText } })
    .from(jobs)
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .innerJoin(careerSources, eq(jobs.sourceId, careerSources.id))
    .leftJoin(decisions, and(eq(decisions.jobId, jobs.id), eq(decisions.superseded, false)));
}

/** Every in-table (keyword+location gate passed) job: the main roles table before display filters. */
export async function fetchTableJobs(archived = false, summary = false): Promise<RoleRow[]> {
  const rows = await baseRolesSelect(summary).where(and(archived ? isNotNull(jobs.archivedAt) : isNull(jobs.archivedAt), archived ? undefined : eq(jobs.inTable, true), ne(companies.status, "archived")));
  return rows.map((r) => ({ ...r, events: [] as RoleEvent[] }));
}

/** Fetch the large description payload only for the current page. */
export async function fetchRoleDetails(ids: string[]): Promise<RoleRow[]> {
  if (!ids.length) return [];
  const rows = await baseRolesSelect().where(inArray(jobs.id, ids)).limit(ids.length);
  return rows.map(row => ({ ...row, events: [] }));
}

/** Most recent job_events per job id, newest first, capped per job. */
export async function fetchRecentEventsFor(jobIds: string[], perJobLimit = 6): Promise<Map<string, RoleEvent[]>> {
  const map = new Map<string, RoleEvent[]>();
  if (jobIds.length === 0) return map;
  const ranked = db().select({ id: jobEvents.id, jobId: jobEvents.jobId, type: jobEvents.type,
    payload: jobEvents.payload, at: jobEvents.at,
    rank: sql<number>`row_number() over (partition by ${jobEvents.jobId} order by ${jobEvents.at} desc, ${jobEvents.id})`.as("event_rank"),
  }).from(jobEvents).where(inArray(jobEvents.jobId, jobIds)).as("ranked_events");
  const rows = await db().select().from(ranked).where(lte(ranked.rank, perJobLimit)).orderBy(desc(ranked.at));
  for (const row of rows) {
    const existing = map.get(row.jobId);
    const entry: RoleEvent = { id: row.id, type: row.type, payload: row.payload, at: row.at };
    if (existing) {
      if (existing.length < perJobLimit) existing.push(entry);
    } else {
      map.set(row.jobId, [entry]);
    }
  }
  return map;
}

export function attachEvents(rows: RoleRow[], eventsByJob: Map<string, RoleEvent[]>): RoleRow[] {
  return rows.map((r) => ({ ...r, events: eventsByJob.get(r.job.id) ?? [] }));
}

// ---------------------------------------------------------------------------
// Filters, parsed from URL search params. Kept pure and independently testable;
// status/location filtering happens in JS per docs/SPEC.md guidance (single-user scale).
// ---------------------------------------------------------------------------

export const STATUS_VALUES = ["new", "active", "closed"] as const;
export type StatusFilter = (typeof STATUS_VALUES)[number];

export const DECISION_VALUES = ["inbox", "all", "undecided", "apply", "skip"] as const;
export type DecisionFilter = (typeof DECISION_VALUES)[number];

export const SORT_KEYS = ["status", "fit", "company", "liveFor", "firstSeen", "title", "location"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export type SortDir = "asc" | "desc";

export const DEFAULT_SORT_DIR: Record<SortKey, SortDir> = {
  status: "asc",
  fit: "desc",
  company: "asc",
  liveFor: "desc",
  firstSeen: "desc",
  title: "asc",
  location: "asc",
};

export interface RolesFilters {
  status: StatusFilter[];
  company: string;
  decision: DecisionFilter;
  minFit: number | null;
  location: string;
  q: string;
  showHidden: boolean;
  closed: boolean;
  sort: SortKey;
  dir: SortDir;
}

export type RawSearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function toList(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .flatMap((s) => s.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseRolesFilters(sp: RawSearchParams): RolesFilters {
  const statusRaw = toList(sp.status).filter((s): s is StatusFilter => (STATUS_VALUES as readonly string[]).includes(s));
  const status = sp.status === undefined ? (["new", "active"] as StatusFilter[]) : statusRaw;

  const decisionRaw = first(sp.decision);
  const decision = (DECISION_VALUES as readonly string[]).includes(decisionRaw ?? "") ? (decisionRaw as DecisionFilter) : "inbox";

  const minFitRaw = first(sp.minFit);
  const minFitNum = minFitRaw === undefined || minFitRaw === "" ? NaN : Number(minFitRaw);
  const minFit = Number.isFinite(minFitNum) ? minFitNum : null;

  const sortRaw = first(sp.sort);
  const sort = (SORT_KEYS as readonly string[]).includes(sortRaw ?? "") ? (sortRaw as SortKey) : "status";

  const dirRaw = first(sp.dir);
  const dir: SortDir = dirRaw === "asc" || dirRaw === "desc" ? dirRaw : DEFAULT_SORT_DIR[sort];

  return {
    status,
    company: first(sp.company) ?? "",
    decision,
    minFit,
    location: (first(sp.location) ?? "").trim(),
    q: (first(sp.q) ?? "").trim(),
    showHidden: first(sp.showHidden) === "1",
    closed: first(sp.closed) === "1",
    sort,
    dir,
  };
}

function locationMatches(job: Job, needle: string): boolean {
  const t = needle.toLowerCase();
  if (job.location && job.location.toLowerCase().includes(t)) return true;
  return (job.locations ?? []).some((l) => l.toLowerCase().includes(t));
}

export function matchesRolesFilters(row: RoleRow, filters: RolesFilters, now: Date): boolean {
  const status = displayStatus(row.job, now);
  const effectiveStatuses = filters.closed && !filters.status.includes("closed") ? [...filters.status, "closed" as StatusFilter] : filters.status;
  if (effectiveStatuses.length > 0 && !effectiveStatuses.includes(status)) return false;

  if (filters.company && row.company.id !== filters.company) return false;

  if (filters.decision === "inbox" && row.decision?.decision === "skip") return false;
  if (filters.decision === "undecided" && row.decision) return false;
  if (filters.decision === "apply" && row.decision?.decision !== "apply") return false;
  if (filters.decision === "skip" && row.decision?.decision !== "skip") return false;

  if (filters.minFit !== null && (row.job.fitScore === null || row.job.fitScore < filters.minFit)) return false;

  if (filters.location && !locationMatches(row.job, filters.location)) return false;

  if (filters.q && !row.job.title.toLowerCase().includes(filters.q.toLowerCase())) return false;

  return true;
}

export function applyRolesFilters(rows: RoleRow[], filters: RolesFilters, now: Date = new Date()): RoleRow[] {
  return rows.filter((r) => matchesRolesFilters(r, filters, now));
}

function statusRank(status: DisplayStatus): number {
  return status === "new" ? 0 : status === "active" ? 1 : 2;
}

function compareFitAsc(a: RoleRow, b: RoleRow): number {
  const fa = a.job.fitScore;
  const fb = b.job.fitScore;
  if (fa === null && fb === null) return 0;
  if (fa === null) return 1; // nulls always sort last
  if (fb === null) return -1;
  return fa - fb;
}

function compareRows(a: RoleRow, b: RoleRow, sort: SortKey, now: Date): number {
  switch (sort) {
    case "status": {
      const sa = displayStatus(a.job, now);
      const sb = displayStatus(b.job, now);
      const rankDiff = statusRank(sa) - statusRank(sb);
      if (rankDiff !== 0) return rankDiff;
      const fitDiff = a.job.fitScore === null || b.job.fitScore === null ? compareFitAsc(a, b) : compareFitAsc(b, a); // desc by default within the same status
      if (fitDiff !== 0) return fitDiff;
      return b.job.firstSeenAt.getTime() - a.job.firstSeenAt.getTime();
    }
    case "fit":
      return compareFitAsc(a, b);
    case "company":
      return a.company.name.localeCompare(b.company.name);
    case "liveFor":
      return liveFor(a.job, now).days - liveFor(b.job, now).days;
    case "firstSeen":
      return a.job.firstSeenAt.getTime() - b.job.firstSeenAt.getTime();
    case "title":
      return a.job.title.localeCompare(b.job.title);
    case "location":
      return (a.job.location ?? "").localeCompare(b.job.location ?? "");
    default:
      return 0;
  }
}

export function sortRoleRows(rows: RoleRow[], sort: SortKey, dir: SortDir, now: Date = new Date()): RoleRow[] {
  const sorted = [...rows].sort((a, b) => {
    if (sort === "fit" && (a.job.fitScore === null || b.job.fitScore === null)) return compareFitAsc(a, b);
    return compareRows(a, b, sort, now) * (dir === "desc" ? -1 : 1);
  });
  return sorted;
}

/** Serialise filters back to a query string, e.g. for the CSV export link. */
export function filtersToQueryString(filters: RolesFilters): string {
  const params = new URLSearchParams();
  for (const s of filters.status) params.append("status", s);
  if (filters.company) params.set("company", filters.company);
  if (filters.decision !== "inbox") params.set("decision", filters.decision);
  if (filters.minFit !== null) params.set("minFit", String(filters.minFit));
  if (filters.location) params.set("location", filters.location);
  if (filters.q) params.set("q", filters.q);
  if (filters.showHidden) params.set("showHidden", "1");
  if (filters.closed) params.set("closed", "1");
  params.set("sort", filters.sort);
  params.set("dir", filters.dir);
  return params.toString();
}

/** Split in-table open roles below the hide threshold into a separate bucket, unless showHidden is set. */
export function splitHidden(rows: RoleRow[], hideThreshold: number | null, showHidden: boolean): { visible: RoleRow[]; hidden: RoleRow[] } {
  if (hideThreshold === null || showHidden) return { visible: rows, hidden: [] };
  const visible: RoleRow[] = [];
  const hidden: RoleRow[] = [];
  for (const row of rows) {
    const isHiddenCandidate = row.job.status === "open" && (row.job.fitScore === null ? false : row.job.fitScore < hideThreshold);
    (isHiddenCandidate ? hidden : visible).push(row);
  }
  return { visible, hidden };
}

// ---------------------------------------------------------------------------
// View model: presentation-ready, JSON-serialisable shape for client components.
// All date formatting happens here (server-side) so client components never
// need to recompute a relative time against a fresh `Date.now()`, which would
// risk a hydration mismatch.
// ---------------------------------------------------------------------------

export interface RoleDecisionVM {
  id: string;
  decision: "apply" | "skip";
  reason: string;
  createdLabel: string;
}

export interface RoleEventVM {
  id: string;
  type: string;
  label: string;
  title: string;
}

export interface RoleRowVM {
  id: string;
  companyId: string;
  companyName: string;
  companyFaviconUrl: string | null;
  companyHomepageUrl: string;
  title: string;
  url: string;
  location: string | null;
  locations: string[];
  remote: boolean;
  department: string | null;
  employmentType: string | null;
  salaryText: string | null;
  status: DisplayStatus;
  liveForText: string;
  liveForTitle: string;
  seeded: boolean;
  fitScore: number | null;
  fitRationale: string | null;
  keywordTerms: string[];
  sourceType: SourceType;
  firstSeenLabel: string;
  firstSeenTitle: string;
  postedLabel: string | null;
  postedTitle: string | null;
  closedLabel: string | null;
  closedTitle: string | null;
  descriptionText: string | null;
  decision: RoleDecisionVM | null;
  events: RoleEventVM[];
}

export function buildRoleRowVM(row: RoleRow, now: Date = new Date()): RoleRowVM {
  const status = displayStatus(row.job, now);
  const { days, basis } = liveFor(row.job, now);
  let liveForTitle =
    basis === "first_seen"
      ? "Counted from when this tool first saw the role; the source publishes no posted date."
      : "Counted from the date the source published for this role.";
  if (row.job.seeded) liveForTitle += " (seeded on first scan)";
  const liveForText = formatDuration(days) + (basis === "first_seen" ? "*" : "");

  return {
    id: row.job.id,
    companyId: row.company.id,
    companyName: row.company.name,
    companyFaviconUrl: row.company.faviconUrl,
    companyHomepageUrl: row.company.homepageUrl,
    title: row.job.title,
    url: row.job.url,
    location: row.job.location,
    locations: row.job.locations,
    remote: !!row.job.remote,
    department: row.job.department,
    employmentType: row.job.employmentType,
    salaryText: row.job.salaryText,
    status,
    liveForText,
    liveForTitle,
    seeded: row.job.seeded,
    fitScore: row.job.fitScore,
    fitRationale: row.job.fitRationale,
    keywordTerms: row.job.keywordTerms,
    sourceType: row.sourceType,
    firstSeenLabel: relativeTime(row.job.firstSeenAt, now),
    firstSeenTitle: row.job.firstSeenAt.toISOString(),
    postedLabel: row.job.postedAt ? relativeTime(row.job.postedAt, now) : null,
    postedTitle: row.job.postedAt ? row.job.postedAt.toISOString() : null,
    closedLabel: row.job.closedAt ? relativeTime(row.job.closedAt, now) : null,
    closedTitle: row.job.closedAt ? row.job.closedAt.toISOString() : null,
    descriptionText: row.job.descriptionText,
    decision: row.decision
      ? { id: row.decision.id, decision: row.decision.decision, reason: row.decision.reason, createdLabel: relativeTime(row.decision.createdAt, now) }
      : null,
    events: row.events.map((e) => ({ id: e.id, type: e.type, label: eventTypeLabel(e.type), title: `${relativeTime(e.at, now)} · ${e.at.toISOString()}` })),
  };
}

/** SQL filters and pagination: descriptions for at most one visible and one hidden page. */
export async function fetchRolePage(filters: RolesFilters, archived: boolean, threshold: number | null, requestedPage: number, now = new Date()) {
  const started = Date.now();
  const liveStart = sql`case when ${jobs.postedAt} <= ${jobs.firstSeenAt} + interval '1 day' then ${jobs.postedAt} else ${jobs.firstSeenAt} end`;
  const status = sql`case when ${jobs.status} = 'closed' then 'closed' when ${liveStart} >= ${new Date(now.getTime() - 7 * 86400000)} then 'new' else 'active' end`;
  const statuses = filters.closed ? [...new Set([...filters.status, 'closed'])] : filters.status;
  const conditions = and(
    archived ? isNotNull(jobs.archivedAt) : and(isNull(jobs.archivedAt), eq(jobs.inTable, true)), ne(companies.status, 'archived'),
    statuses.length ? inArray(status, statuses) : undefined,
    filters.company ? eq(companies.id, filters.company) : undefined,
    filters.decision === 'inbox' ? sql`(${decisions.decision} is null or ${decisions.decision} <> 'skip')` : filters.decision === 'undecided' ? isNull(decisions.id) : ['apply','skip'].includes(filters.decision) ? eq(decisions.decision, filters.decision as 'apply' | 'skip') : undefined,
    filters.minFit !== null ? sql`${jobs.fitScore} >= ${filters.minFit}` : undefined,
    filters.q ? sql`position(lower(${filters.q}) in lower(${jobs.title})) > 0` : undefined,
    filters.location ? sql`(position(lower(${filters.location}) in lower(coalesce(${jobs.location}, ''))) > 0 or exists (select 1 from jsonb_array_elements_text(${jobs.locations}) l where position(lower(${filters.location}) in lower(l)) > 0))` : undefined,
  );
  const hidden = threshold !== null && !filters.showHidden ? sql`(${jobs.status} = 'open' and ${jobs.fitScore} is not null and ${jobs.fitScore} < ${threshold})` : sql`false`;
  const countFor = async (extra: ReturnType<typeof sql>) => {
    const [row] = await db().select({ n: sql<number>`count(*)::int` }).from(baseRolesSelect(true).where(and(conditions, extra)).as('filtered'));
    return row?.n ?? 0;
  };
  const [total, hiddenTotal] = await Promise.all([countFor(sql`not ${hidden}`), countFor(hidden)]);
  const pageCount = Math.max(1, Math.ceil(total / 50));
  const page = Math.min(pageCount, Math.max(1, Number.isSafeInteger(requestedPage) ? requestedPage : 1));
  const direction = sql.raw(filters.dir === 'desc' ? 'desc' : 'asc');
  const sorts = {
    status: sql`case ${status} when 'new' then 0 when 'active' then 1 else 2 end`,
    fit: jobs.fitScore, company: companies.name, firstSeen: jobs.firstSeenAt, title: jobs.title, location: sql`coalesce(${jobs.location}, '')`,
    liveFor: sql`greatest(0, floor(extract(epoch from (case when ${jobs.status} = 'closed' then coalesce(${jobs.closedAt}, ${now}) else ${now} end - (${liveStart}))) / 86400))`,
  };
  const order = filters.sort === 'status'
    ? [sql`${sorts.status} ${direction}`, sql`${jobs.fitScore} ${filters.dir === 'asc' ? sql`desc nulls last` : sql`asc nulls first`}`, sql`${jobs.firstSeenAt} ${filters.dir === 'asc' ? sql`desc` : sql`asc`}`, jobs.id]
    : [sql`${sorts[filters.sort]} ${direction} nulls last`, jobs.id];
  const [visible, concealed] = await Promise.all([
    baseRolesSelect().where(and(conditions, sql`not ${hidden}`)).orderBy(...order).limit(50).offset((page - 1) * 50),
    hiddenTotal ? baseRolesSelect().where(and(conditions, hidden)).orderBy(...order).limit(50) : Promise.resolve([]),
  ]);
  console.info(JSON.stringify({ event: 'role_page', durationMs: Date.now() - started, rows: visible.length, total, page }));
  return { visible: visible.map(row => ({ ...row, events: [] as RoleEvent[] })), hidden: concealed.map(row => ({ ...row, events: [] as RoleEvent[] })), total, hiddenTotal, page, pageCount };
}
