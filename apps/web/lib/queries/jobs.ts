import { and, desc, eq, gte, inArray, ne, isNull, isNotNull } from "drizzle-orm";
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

function baseRolesSelect() {
  return db()
    .select(roleRowSelection)
    .from(jobs)
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .innerJoin(careerSources, eq(jobs.sourceId, careerSources.id))
    .leftJoin(decisions, and(eq(decisions.jobId, jobs.id), eq(decisions.superseded, false)));
}

/** Every in-table (keyword+location gate passed) job: the main roles table before display filters. */
export async function fetchTableJobs(archived = false): Promise<RoleRow[]> {
  const rows = await baseRolesSelect().where(and(archived ? isNotNull(jobs.archivedAt) : isNull(jobs.archivedAt), archived ? undefined : eq(jobs.inTable, true), ne(companies.status, "archived")));
  return rows.map((r) => ({ ...r, events: [] as RoleEvent[] }));
}

/** Roles that failed the keyword/location gate but scored well: "Outside your keywords". */
export async function fetchNearMissJobs(settings: Pick<AppSettings, "nearMissMinScore">, cap = 10): Promise<RoleRow[]> {
  const rows = await baseRolesSelect()
    .where(and(isNull(jobs.archivedAt), ne(companies.status, "archived"), eq(jobs.nearMiss, true), eq(jobs.status, "open"), gte(jobs.fitScore, settings.nearMissMinScore)))
    .orderBy(desc(jobs.firstSeenAt))
    .limit(cap);
  return rows.map((r) => ({ ...r, events: [] as RoleEvent[] }));
}

/** Most recent job_events per job id, newest first, capped per job. */
export async function fetchRecentEventsFor(jobIds: string[], perJobLimit = 6): Promise<Map<string, RoleEvent[]>> {
  const map = new Map<string, RoleEvent[]>();
  if (jobIds.length === 0) return map;
  const rows = await db()
    .select({ id: jobEvents.id, jobId: jobEvents.jobId, type: jobEvents.type, payload: jobEvents.payload, at: jobEvents.at })
    .from(jobEvents)
    .where(inArray(jobEvents.jobId, jobIds))
    .orderBy(desc(jobEvents.at));
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

export const DECISION_VALUES = ["all", "undecided", "apply", "skip"] as const;
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
  const decision = (DECISION_VALUES as readonly string[]).includes(decisionRaw ?? "") ? (decisionRaw as DecisionFilter) : "all";

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
  if (filters.decision !== "all") params.set("decision", filters.decision);
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
