import { latestApplicationFor, roleStageSql, roleStatusSql, type LatestApplication } from "@ava/db";
import { deadlineFor, defaultRoleTab, roleStatus, ROLE_STATUSES, ROLE_TABS, type ApplicationStatus, type RoleStage, type RoleStatus, type RoleTab } from "@ava/core";
import { getTableColumns, and, eq, inArray, ne, isNull, sql } from "drizzle-orm";
import { careerSources, companies, decisions, jobs, userJobs, type Job, type ScoreState, type SourceType, type UserJob } from "@ava/db/schema";
import { displayStatus, formatDuration, liveFor, type DisplayStatus } from "@ava/core";
import { db } from "@/lib/db";
import { companyLogoUrl } from "@/lib/company-icon";
import { eventTypeLabel, relativeTime } from "@/lib/format";

export interface RoleCompany {
  id: string;
  name: string;
  faviconUrl: string | null;
  /** When the worker captured this company's logo; the interface serves and versions it by this. */
  logoFetchedAt: Date | null;
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

/** A shared posting seen through one account: the job's fields plus that account's gate, fit and archive state. */
export type RoleJob = Job & Pick<UserJob, "keywordMatched" | "keywordTerms" | "excluded" | "locationOk" | "inTable" | "fitScore" | "fitVerdict" | "fitRationale" | "fitProfileVersion" | "fitScoredAt" | "scoreState" | "scoreStateAt" | "archivedAt">;

export interface RoleRow {
  job: RoleJob;
  company: RoleCompany;
  sourceType: SourceType;
  decision: RoleDecision | null;
  /** Where this role has got to for this account, read at the database (packages/db `roleStageSql`). */
  stage: RoleStage;
  /** The newest application for it, or null when none was ever recorded. */
  applicationStatus: ApplicationStatus | null;
  events: RoleEvent[];
}

const viewColumns = {
  keywordMatched: userJobs.keywordMatched,
  keywordTerms: userJobs.keywordTerms,
  excluded: userJobs.excluded,
  locationOk: userJobs.locationOk,
  inTable: userJobs.inTable,
  fitScore: userJobs.fitScore,
  fitVerdict: userJobs.fitVerdict,
  fitRationale: userJobs.fitRationale,
  fitProfileVersion: userJobs.fitProfileVersion,
  fitScoredAt: userJobs.fitScoredAt,
  // Why a blank score is blank: what the score handler last decided about this role, and when.
  scoreState: userJobs.scoreState,
  scoreStateAt: userJobs.scoreStateAt,
  archivedAt: userJobs.archivedAt,
  // New to this account, whether or not the shared scan had seen it before.
  seeded: userJobs.seeded,
};

/**
 * The stage reads the account's newest application, so the selection is built around that
 * subquery rather than being a constant: `latest` is the one `baseRolesSelect` left-joins.
 */
function roleRowSelection(latest: LatestApplication, userId: string) {
  return {
    company: {
      id: companies.id,
      name: companies.name,
      faviconUrl: companies.faviconUrl,
      logoFetchedAt: companies.logoFetchedAt,
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
    // One reading of the lifecycle for the table, the counts and the export: the same expression
    // the applications table uses, so the two can never disagree about where a role has got to.
    stage: roleStageSql(latest, userId),
    applicationStatus: latest.status,
  } as const;
}

function baseRolesSelect(userId: string, summary = false) {
  const latest = latestApplicationFor(userId);
  return db()
    .select({ ...roleRowSelection(latest, userId), job: { ...getTableColumns(jobs), ...viewColumns, descriptionText: summary ? sql<string | null>`null` : jobs.descriptionText } })
    .from(userJobs)
    .innerJoin(jobs, eq(jobs.id, userJobs.jobId))
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .innerJoin(careerSources, eq(jobs.sourceId, careerSources.id))
    .leftJoin(decisions, and(eq(decisions.userId, userId), eq(decisions.jobId, jobs.id), eq(decisions.superseded, false)))
    .leftJoin(latest, eq(latest.jobId, jobs.id));
}

/**
 * Every in-table (keyword+location gate passed) job: the main roles table before display filters.
 * `summary` leaves the 30k-character description behind, which every caller but role detail wants;
 * `limit` bounds a read that would otherwise grow with the table (the CSV export sets one).
 */
export async function fetchTableJobs(userId: string, archived = false, summary = false, limit?: number): Promise<RoleRow[]> {
  const query = baseRolesSelect(userId, summary).where(and(eq(userJobs.userId, userId), archived ? eq(roleStatusSql, "archived") : ne(roleStatusSql, "archived")));
  const rows = await (limit === undefined ? query : query.limit(limit));
  return rows.map((r) => ({ ...r, events: [] as RoleEvent[] }));
}

/** Fetch the large description payload only for the current page. */
export async function fetchRoleDetails(userId: string, ids: string[]): Promise<RoleRow[]> {
  if (!ids.length) return [];
  const rows = await baseRolesSelect(userId).where(and(eq(userJobs.userId, userId), inArray(jobs.id, ids))).limit(ids.length);
  return rows.map(row => ({ ...row, events: [] }));
}

/**
 * Most recent job_events per job id, newest first, capped per job: shared observations plus this
 * account's own.
 *
 * A posting followed by many accounts carries every one of their scored, decided and hidden
 * events, so the query never reads the job's whole history to rank it: for each job it takes the
 * newest few shared events and the newest few of this account's, each a bounded probe, and keeps
 * the newest few of the two. Another account's events are never read.
 */
export async function fetchRecentEventsFor(userId: string, jobIds: string[], perJobLimit = 6): Promise<Map<string, RoleEvent[]>> {
  const map = new Map<string, RoleEvent[]>();
  const ids = [...new Set(jobIds)];
  if (ids.length === 0) return map;
  // Drizzle renders one placeholder per element, so the array is spelled out rather than passed whole.
  const idArray = sql`array[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]`;
  const result = await db().execute(sql`
    select e.id, e.job_id, e.type, e.payload, e.at
    from unnest(${idArray}) as j(id)
    cross join lateral (
      (select id, job_id, type, payload, at from job_events
        where job_id = j.id and user_id is null
        order by at desc, id limit ${perJobLimit})
      union all
      (select id, job_id, type, payload, at from job_events
        where user_id = ${userId}::uuid and job_id = j.id
        order by at desc, id limit ${perJobLimit})
    ) e
    order by e.job_id, e.at desc, e.id`);
  for (const row of result.rows as Array<{ id: string; job_id: string; type: string; payload: Record<string, unknown>; at: string | Date }>) {
    const existing = map.get(row.job_id);
    const entry: RoleEvent = { id: row.id, type: row.type, payload: row.payload, at: new Date(row.at) };
    if (existing) {
      if (existing.length < perJobLimit) existing.push(entry);
    } else {
      map.set(row.job_id, [entry]);
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

export const SORT_KEYS = ["status", "fit", "company", "liveFor", "firstSeen", "title", "location", "decided"] as const;
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
  // "What did I decide last week?" is answered newest first.
  decided: "desc",
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
  /** `since=7d`: only roles decided within this many days. Null means every decision, however old. */
  sinceDays: number | null;
  sort: SortKey;
  dir: SortDir;
}

/** `since=7d` — a whole number of days, bounded so a hand-edited URL cannot ask for a silly window. */
export function parseSince(raw: string | undefined): number | null {
  const match = /^(\d{1,3})d$/.exec((raw ?? "").trim());
  if (!match) return null;
  const days = Number(match[1]);
  return days >= 1 && days <= 365 ? days : null;
}

export type RawSearchParams = Record<string, string | string[] | undefined>;

/** The three statuses the tab strip shows. Archived is a section inside Dismissed, not a tab. */
export type { RoleTab };

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

/**
 * Which role tab a request is asking for, or null when it asks for none. Archived is not one of
 * them: a link that still says `view=archived` or `archive=1` — a bookmark, a CSV export, an older
 * page — lands on Dismissed, where the archived roles now live, rather than on a tab that no
 * longer exists. A request that names no view at all, and one that names an unknown one, answer
 * null: there is no fixed landing tab any more, so the counts decide (`resolveRoleView`).
 */
export function roleTabFor(sp: RawSearchParams): RoleTab | null {
  const raw = first(sp.view);
  if ((ROLE_TABS as readonly string[]).includes(raw ?? "")) return raw as RoleTab;
  if (raw === "archived" || first(sp.archive) === "1" || first(sp.decision) === "skip") return "user-dismissed";
  if (first(sp.decision) === "apply") return "user-shortlisted";
  return null;
}

/**
 * The tab a request lands on: the one its link names, or — when it names none — the account's
 * default for this scope, which is Matched unless there is nothing matched to review and then
 * Shortlisted. The counts are the scope's own, so a company page with no new roles opens on that
 * company's shortlist rather than on an empty tab.
 */
export function resolveRoleView(sp: RawSearchParams, counts: Partial<Record<RoleStatus, number>>): RoleTab {
  return roleTabFor(sp) ?? defaultRoleTab(counts);
}

export function parseRolesFilters(sp: RawSearchParams): RolesFilters {
  const statusRaw = toList(sp.status).filter((s): s is StatusFilter => (STATUS_VALUES as readonly string[]).includes(s));
  const status = sp.status === undefined ? (["new", "active", "closed"] as StatusFilter[]) : statusRaw;

  const view = first(sp.view);
  const decisionRaw = view === "user-shortlisted" ? "apply" : view === "user-dismissed" ? "skip" : view === "archived" || first(sp.archive) === "1" ? "all" : view === "auto-matched" ? "inbox" : first(sp.decision);
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
    sinceDays: parseSince(first(sp.since)),
    sort,
    dir,
  };
}

/** The cut-off a `since` window makes, or null when the filter names no window. */
export function sinceCutoff(filters: Pick<RolesFilters, "sinceDays">, now: Date): Date | null {
  return filters.sinceDays === null ? null : new Date(now.getTime() - filters.sinceDays * 86400000);
}

function locationMatches(job: RoleJob, needle: string): boolean {
  const t = needle.toLowerCase();
  if (job.location && job.location.toLowerCase().includes(t)) return true;
  return (job.locations ?? []).some((l) => l.toLowerCase().includes(t));
}

export function matchesRolesFilters(row: RoleRow, filters: RolesFilters, now: Date): boolean {
  const status = displayStatus(row.job, now);
  const effectiveStatuses = filters.closed && !filters.status.includes("closed") ? [...filters.status, "closed" as StatusFilter] : filters.status;
  if (effectiveStatuses.length > 0 && !effectiveStatuses.includes(status)) return false;

  if (filters.company && row.company.id !== filters.company) return false;

  if (filters.decision === "inbox" && row.decision) return false;
  if (filters.decision === "undecided" && row.decision) return false;
  if (filters.decision === "apply" && row.decision?.decision !== "apply") return false;
  if (filters.decision === "skip" && row.decision?.decision !== "skip") return false;

  if (filters.minFit !== null && (row.job.fitScore === null || row.job.fitScore < filters.minFit)) return false;

  if (filters.location && !locationMatches(row.job, filters.location)) return false;

  if (filters.q && !row.job.title.toLowerCase().includes(filters.q.toLowerCase())) return false;

  const cutoff = sinceCutoff(filters, now);
  if (cutoff && (!row.decision || row.decision.createdAt < cutoff)) return false;

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
    case "decided":
      // Undecided rows have no date to sort by, so they keep the fit ordering's rule: last.
      return (a.decision?.createdAt.getTime() ?? -Infinity) - (b.decision?.createdAt.getTime() ?? -Infinity);
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
  if (filters.sinceDays !== null) params.set("since", `${filters.sinceDays}d`);
  params.set("sort", filters.sort);
  params.set("dir", filters.dir);
  return params.toString();
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
  /** The exact moment, for the `title` on the relative label. */
  createdTitle: string;
}

export interface RoleEventVM {
  id: string;
  type: string;
  label: string;
  title: string;
}

/**
 * What a missing fit score means, in the words the table shows instead of one em dash.
 *
 * A blank score covers five situations and the row could not tell them apart. The score handler
 * records which one it decided on this account's view of the role (`user_jobs.score_state`); this
 * is the only place that turns those five words into English, so the cell, the review panel and
 * anything else that reads a row say the same thing.
 *
 * `queued` is the one state that goes stale: the task may have been abandoned, so a queue entry
 * older than the score task's own deadline stops claiming that something is working on it. A score
 * that is present needs no sentence — the bar is the answer — and a row from before the column
 * existed has nothing recorded, which reads as never scored.
 */
export function scoreStateText(
  view: { fitScore: number | null; scoreState: ScoreState | null; scoreStateAt: Date | null },
  now: Date = new Date(),
): string | null {
  if (view.fitScore !== null) return null;
  switch (view.scoreState) {
    case "queued": {
      const fresh = view.scoreStateAt !== null && now.getTime() - view.scoreStateAt.getTime() < deadlineFor("score_job");
      return fresh ? "scoring…" : "not scored yet";
    }
    case "budget":
      return "not scored: budget spent";
    case "closed":
      return "closed";
    // The handler's own words: the role neither matches your filters nor is shortlisted, so it was
    // not worth a model call. Widening the gate or shortlisting it queues one.
    case "ineligible":
      return "not scored: outside your filters";
    default:
      return "not scored yet";
  }
}

export interface RoleRowVM {
  id: string;
  companyId: string;
  companyName: string;
  companyFaviconUrl: string | null;
  /** The interface's own URL for the captured logo, or null while nothing is stored. */
  companyLogoUrl: string | null;
  companyDomain: string;
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
  workflowStatus: RoleStatus;
  /** How far this role has got for this account: what the Shortlisted tab badges. */
  stage: RoleStage;
  /** The newest application's own status, so "In process" can name its step. */
  applicationStatus: ApplicationStatus | null;
  liveForText: string;
  liveForTitle: string;
  seeded: boolean;
  fitScore: number | null;
  /** What the score handler last decided about this role, or null for a row that predates it. */
  scoreState: ScoreState | null;
  /** That state in English, shown where the score would be, or null when there is a score. */
  scoreStateText: string | null;
  /** The A5 verdict stored beside the score (R-6.6): shown beside it, never instead of it. */
  fitVerdict: "strong" | "possible" | "unlikely" | null;
  fitRationale: string | null;
  keywordTerms: string[];
  /** This account's stored location verdict for the posting (`user_jobs.location_ok`). */
  locationOk: boolean;
  sourceType: SourceType;
  firstSeenLabel: string;
  firstSeenTitle: string;
  postedLabel: string | null;
  postedTitle: string | null;
  closedLabel: string | null;
  closedTitle: string | null;
  /** This account pasted this posting's URL: it is in the table whatever its gate said. */
  addedByYou: boolean;
  decision: RoleDecisionVM | null;
  events: RoleEventVM[];
}

/**
 * `viewerId` decides one thing only: whether this account is the one that added the posting by
 * URL. A row is built for exactly one reader, so it is the reader's id, never the job's owner.
 */
export function buildRoleRowVM(row: RoleRow, now: Date = new Date(), viewerId?: string): RoleRowVM {
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
    companyLogoUrl: companyLogoUrl(row.company.id, row.company.logoFetchedAt),
    companyDomain: row.company.domain,
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
    workflowStatus: roleStatus(row.job, row.decision),
    stage: row.stage,
    applicationStatus: row.applicationStatus,
    liveForText,
    liveForTitle,
    seeded: row.job.seeded,
    fitScore: row.job.fitScore,
    scoreState: row.job.scoreState,
    scoreStateText: scoreStateText(row.job, now),
    fitVerdict: row.job.fitVerdict,
    fitRationale: row.job.fitRationale,
    keywordTerms: row.job.keywordTerms,
    locationOk: row.job.locationOk,
    sourceType: row.sourceType,
    firstSeenLabel: relativeTime(row.job.firstSeenAt, now),
    firstSeenTitle: row.job.firstSeenAt.toISOString(),
    postedLabel: row.job.postedAt ? relativeTime(row.job.postedAt, now) : null,
    postedTitle: row.job.postedAt ? row.job.postedAt.toISOString() : null,
    closedLabel: row.job.closedAt ? relativeTime(row.job.closedAt, now) : null,
    closedTitle: row.job.closedAt ? row.job.closedAt.toISOString() : null,
    addedByYou: row.job.origin === "user" && !!viewerId && row.job.addedBy === viewerId,
    decision: row.decision
      ? { id: row.decision.id, decision: row.decision.decision, reason: row.decision.reason, createdLabel: relativeTime(row.decision.createdAt, now), createdTitle: row.decision.createdAt.toISOString() }
      : null,
    events: row.events.map((e) => ({ id: e.id, type: e.type, label: e.payload.action === "archived" ? `Archived: ${e.payload.reason ?? "Put away by you"}` : e.payload.action === "restored" ? "Restored by you" : eventTypeLabel(e.type), title: `${relativeTime(e.at, now)} · ${e.at.toISOString()}` })),
  };
}

/**
 * The one reading of a filtered view in SQL — the `where` and the `order by` the table, its counts
 * and the CSV export all share, so the file and the screen cannot disagree about which roles are in
 * a view or in what order (R-7.5).
 */
function rolesQuery(userId: string, filters: RolesFilters, archived: boolean, now: Date) {
  const liveStart = sql`case when ${jobs.postedAt} <= ${jobs.firstSeenAt} + interval '1 day' then ${jobs.postedAt} else ${jobs.firstSeenAt} end`;
  const status = sql`case when ${jobs.status} = 'closed' then 'closed' when ${liveStart} >= ${new Date(now.getTime() - 7 * 86400000)} then 'new' else 'active' end`;
  const statuses = filters.closed ? [...new Set([...filters.status, 'closed'])] : filters.status;
  const cutoff = sinceCutoff(filters, now);
  const conditions = and(
    eq(userJobs.userId, userId),
    archived ? eq(roleStatusSql, "archived") : ne(roleStatusSql, "archived"),
    statuses.length ? inArray(status, statuses) : undefined,
    filters.company ? eq(companies.id, filters.company) : undefined,
    filters.decision === 'inbox' ? isNull(decisions.id) : filters.decision === 'undecided' ? isNull(decisions.id) : ['apply','skip'].includes(filters.decision) ? eq(decisions.decision, filters.decision as 'apply' | 'skip') : undefined,
    filters.minFit !== null ? sql`${userJobs.fitScore} >= ${filters.minFit}` : undefined,
    filters.q ? sql`position(lower(${filters.q}) in lower(${jobs.title})) > 0` : undefined,
    filters.location ? sql`(position(lower(${filters.location}) in lower(coalesce(${jobs.location}, ''))) > 0 or exists (select 1 from jsonb_array_elements_text(${jobs.locations}) l where position(lower(${filters.location}) in lower(l)) > 0))` : undefined,
    // "This week": the window is on the decision, so an undecided role is never in a `since` view.
    cutoff ? sql`${decisions.createdAt} >= ${cutoff}` : undefined,
  );
  const direction = sql.raw(filters.dir === 'desc' ? 'desc' : 'asc');
  const sorts = {
    status: sql`case ${status} when 'new' then 0 when 'active' then 1 else 2 end`,
    fit: userJobs.fitScore, company: companies.name, firstSeen: jobs.firstSeenAt, title: jobs.title, location: sql`coalesce(${jobs.location}, '')`,
    decided: decisions.createdAt,
    liveFor: sql`greatest(0, floor(extract(epoch from (case when ${jobs.status} = 'closed' then coalesce(${jobs.closedAt}, ${now}) else ${now} end - (${liveStart}))) / 86400))`,
  };
  const order = filters.sort === 'status'
    ? [sql`${sorts.status} ${direction}`, sql`${userJobs.fitScore} ${filters.dir === 'asc' ? sql`desc nulls last` : sql`asc nulls first`}`, sql`${jobs.firstSeenAt} ${filters.dir === 'asc' ? sql`desc` : sql`asc`}`, jobs.id]
    : [sql`${sorts[filters.sort]} ${direction} nulls last`, jobs.id];
  return { conditions, order };
}

/**
 * One block of a filtered view, at any offset and size: the table reads 50 of these, the export
 * reads them 500 at a time until its cap. Summary rows either way — nothing that renders a block
 * renders the stored description, and 50 of them is up to 1.5 MB read and serialised on every
 * render and every pagination click.
 */
export async function fetchRoleRows(userId: string, filters: RolesFilters, archived: boolean, { offset = 0, limit = 50, now = new Date() }: { offset?: number; limit?: number; now?: Date } = {}): Promise<RoleRow[]> {
  const { conditions, order } = rolesQuery(userId, filters, archived, now);
  const rows = await baseRolesSelect(userId, true).where(conditions).orderBy(...order).limit(limit).offset(offset);
  return rows.map(row => ({ ...row, events: [] as RoleEvent[] }));
}

/**
 * What the review panel loads on expand: the evidence a decision needs that the page read leaves in
 * the database (the description) or that no column on the row can carry. One round trip per row.
 */
/** What a CV build for this role would cost, as the panel's button says it. */
export interface CvQuoteVM {
  /** "about $3.10 of $18.40 left", for the button's own label. */
  line: string;
  /** The budget's refusal, or null when the estimate fits. */
  refusal: string | null;
}

export interface RoleDetailsVM {
  jobId: string;
  /** The stored description, as the extractor cleaned it. Null when no scan has fetched one yet. */
  description: string | null;
  salaryText: string | null;
  department: string | null;
  employmentType: string | null;
  /** The account's own gate hits (R-5.5), rendered as chips. */
  keywordTerms: string[];
  fitVerdict: "strong" | "possible" | "unlikely" | null;
  fitRationale: string | null;
  /** One line on why this role passed the location filter. */
  locationReason: string;
  /**
   * The price of building a CV for this role, for the button the panel offers a shortlisted role.
   * Null when there is nothing to quote: the role has not been shortlisted, or the account has no
   * Library to write from yet, which is the Library's own first step rather than a price.
   */
  cvQuote: CvQuoteVM | null;
  /** Why that build cannot be asked for yet — an unconfirmed address — or null when it can. */
  cvBlocked: string | null;
}

/**
 * Why a role passed this account's location filter, in one line (the other half of R-5.5's "why is
 * this here"). `user_jobs` stores only the boolean verdict, so the terms behind it are recomputed
 * from the stored posting and the account's own gate when the review panel opens — the same
 * `evaluateLocation` the gate itself runs, never a second rule.
 */
export function locationReasonText(evaluated: { ok: boolean; terms: string[]; remote: boolean }, hasLocationFilter: boolean, addedByYou: boolean): string {
  if (!evaluated.ok) {
    return addedByYou
      ? "Outside your location filter — it is here because you added it by its URL."
      : "Outside your location filter — it is here because you decided on it.";
  }
  if (!hasLocationFilter) return evaluated.remote ? "Remote, and your filter names no location, so every location passes." : "Your filter names no location, so every location passes.";
  const named = evaluated.terms.filter(term => term !== "remote");
  if (named.length) return `Matches your location filter: ${named.join(", ")}.`;
  return "Remote, and your filter allows remote roles.";
}

/** SQL filters and pagination for one 50-row page; descriptions are left in the database. */
export async function fetchRolePage(userId: string, filters: RolesFilters, archived: boolean, threshold: number | null, requestedPage: number, now = new Date()) {
  const started = Date.now();
  const { conditions } = rolesQuery(userId, filters, archived, now);
  const [counted] = await db().select({ n: sql<number>`count(*)::int` }).from(baseRolesSelect(userId, true).where(conditions).as('filtered'));
  const total = counted?.n ?? 0;
  // Fit is an explicit filter, never a second hidden workflow: nothing is ever held back.
  const hiddenTotal = 0;
  const pageCount = Math.max(1, Math.ceil(total / 50));
  const page = Math.min(pageCount, Math.max(1, Number.isSafeInteger(requestedPage) ? requestedPage : 1));
  const visible = await fetchRoleRows(userId, filters, archived, { offset: (page - 1) * 50, limit: 50, now });
  console.info(JSON.stringify({ event: 'role_page', durationMs: Date.now() - started, rows: visible.length, total, page }));
  return { visible, hidden: [] as RoleRow[], total, hiddenTotal, page, pageCount };
}


/**
 * How many of the roles in hand have actually been applied for, from the pipeline's stage counts:
 * the breakdown behind "Shortlisted 12 · 3 applied".
 *
 * Every stage that means an application was sent counts — applied, in process, and the two
 * outcomes, because an employer's answer does not unsend the application. `applying` does not: a
 * CV is being built and nothing has gone anywhere. `dismissed` does not either: a withdrawal can
 * come from either side of that line, so it is not evidence of an application.
 */
export const APPLIED_ROLE_STAGES = ["applied", "in_process", "accepted", "rejected"] as const;

export function appliedRoleCount(stageCounts: Partial<Record<RoleStage, number>>): number {
  return APPLIED_ROLE_STAGES.reduce((total, stage) => total + (stageCounts[stage] ?? 0), 0);
}

export async function fetchRoleCounts(userId: string, companyId?: string): Promise<Record<RoleStatus, number>> {
  const rows = await db().select({ status: roleStatusSql, n: sql<number>`count(*)::int` }).from(userJobs)
    .innerJoin(jobs, eq(jobs.id, userJobs.jobId))
    .leftJoin(decisions, and(eq(decisions.userId, userId), eq(decisions.jobId, jobs.id), eq(decisions.superseded, false)))
    .where(and(eq(userJobs.userId, userId), companyId ? eq(jobs.companyId, companyId) : undefined)).groupBy(roleStatusSql);
  const counts = Object.fromEntries(ROLE_STATUSES.map(status => [status, 0])) as Record<RoleStatus, number>;
  for (const row of rows) counts[row.status] = row.n;
  return counts;
}
