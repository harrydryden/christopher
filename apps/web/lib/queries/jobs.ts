import { latestApplicationFor, roleStageSql, roleStatusSql, type LatestApplication } from "@ava/db";
import { deadlineFor, defaultRoleTab, roleStatus, ROLE_STATUSES, ROLE_TABS, type ApplicationStatus, type RoleStage, type RoleStatus, type RoleTab } from "@ava/core";
import { getTableColumns, and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { careerSources, companies, decisions, jobs, userJobs, type Job, type ScoreState, type SourceType, type UserJob } from "@ava/db/schema";
import { displayStatus, formatDuration, liveFor, type DisplayStatus } from "@ava/core";
import { cache } from "react";
import { db } from "@/lib/db";
import { companyIcon } from "@/lib/company-icon";
import { relativeTime } from "@/lib/format";

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

function baseRolesSelect(userId: string, summary = false, cursor: SQL<RoleCursor> = sql<RoleCursor>`null`) {
  const latest = latestApplicationFor(userId);
  return db()
    .select({ ...roleRowSelection(latest, userId), job: { ...getTableColumns(jobs), ...viewColumns, descriptionText: summary ? sql<string | null>`null` : jobs.descriptionText }, cursor })
    .from(userJobs)
    .innerJoin(jobs, eq(jobs.id, userJobs.jobId))
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .innerJoin(careerSources, eq(jobs.sourceId, careerSources.id))
    .leftJoin(decisions, and(eq(decisions.userId, userId), eq(decisions.jobId, jobs.id), eq(decisions.superseded, false)))
    .leftJoin(latest, eq(latest.jobId, jobs.id));
}

/** Fetch the large description payload only for the current page. */
export async function fetchRoleDetails(userId: string, ids: string[]): Promise<RoleRow[]> {
  if (!ids.length) return [];
  const rows = await baseRolesSelect(userId).where(and(eq(userJobs.userId, userId), inArray(jobs.id, ids))).limit(ids.length);
  return rows;
}

/**
 * The archive notes the review panel shows for one role ("Archived: No longer matches your
 * criteria"), read when the row expands rather than for every row of every page. Of the role's
 * newest few events — shared observations and this account's own, each a bounded probe, so a
 * posting followed by many accounts is never read whole and another account's events never — the ones that put it away, newest first. Only the two payload fields a
 * note says are read, never the whole payload.
 */
export async function fetchArchiveNotes(userId: string, jobId: string, recent = 6): Promise<string[]> {
  const result = await db().execute(sql`
    select e.action, e.reason from (
      (select id, at, payload->>'action' as action, payload->>'reason' as reason from job_events
        where job_id = ${jobId}::uuid and user_id is null order by at desc, id limit ${recent})
      union all
      (select id, at, payload->>'action' as action, payload->>'reason' as reason from job_events
        where user_id = ${userId}::uuid and job_id = ${jobId}::uuid order by at desc, id limit ${recent})
    ) e
    order by e.at desc, e.id limit ${recent}`);
  return (result.rows as Array<{ action: string | null; reason: string | null }>)
    .filter((row) => row.action === "archived")
    .map((row) => `Archived: ${row.reason ?? "Put away by you"}`);
}

// ---------------------------------------------------------------------------
// Filters, parsed from URL search params. Kept pure and independently testable; the filtering and
// ordering they ask for happen in SQL (`rolesQuery`).
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

/**
 * One row of the roles table, as the client component receives it. Every key of every row is
 * serialised into the page (RSC dedupes nothing across rows), so a row carries only what the table
 * renders: the company's icon and website travel once per company in `RoleCompaniesVM`, and a
 * sentence that is one of two fixed ones travels as the choice between them (`liveForBasis`).
 */
export interface RoleRowVM {
  id: string;
  /** The key into the page's `RoleCompaniesVM`. */
  companyId: string;
  companyName: string;
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
  /** What `liveForText` counts from; the table holds the sentence for each (`liveForTitle`). */
  liveForBasis: "posted" | "first_seen";
  /** New to this account on the scan that first admitted it, rather than on a later one. */
  seeded: boolean;
  fitScore: number | null;
  /** What the score handler last decided about this role, or null for a row that predates it. */
  scoreState: ScoreState | null;
  /** That state in English, shown where the score would be, or null when there is a score. */
  scoreStateText: string | null;
  /** The A5 verdict stored beside the score (R-6.6): shown beside it, never instead of it. */
  fitVerdict: "strong" | "possible" | "unlikely" | null;
  /**
   * The A5 rationale: at most two sentences by the prompt's own rule, so it rides on the row, where
   * the fit bar's title shows it without opening the panel.
   */
  fitRationale: string | null;
  keywordTerms: string[];
  /** This account pasted this posting's URL: it is in the table whatever its gate said. */
  addedByYou: boolean;
  decision: RoleDecisionVM | null;
}

/** What the table shows of a company: its icon and its website, once per company on the page. */
export interface RoleCompanyVM {
  /** The captured logo's URL, else the stored favicon, else null for the browser's own chain. */
  iconSrc: string | null;
  domain: string;
  homepageUrl: string;
}

export type RoleCompaniesVM = Record<string, RoleCompanyVM>;

/** The companies of the rows in hand, keyed by id, built from the same rows the table renders. */
export function buildRoleCompanies(rows: readonly Pick<RoleRow, "company">[]): RoleCompaniesVM {
  const companies: RoleCompaniesVM = {};
  for (const { company } of rows) {
    if (companies[company.id]) continue;
    const icon = companyIcon(company);
    companies[company.id] = { iconSrc: icon.src, domain: icon.domain, homepageUrl: company.homepageUrl };
  }
  return companies;
}

/**
 * `viewerId` decides one thing only: whether this account is the one that added the posting by
 * URL. A row is built for exactly one reader, so it is the reader's id, never the job's owner.
 */
export function buildRoleRowVM(row: RoleRow, now: Date = new Date(), viewerId?: string): RoleRowVM {
  const status = displayStatus(row.job, now);
  const { days, basis } = liveFor(row.job, now);
  const liveForText = formatDuration(days) + (basis === "first_seen" ? "*" : "");

  return {
    id: row.job.id,
    companyId: row.company.id,
    companyName: row.company.name,
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
    liveForBasis: basis,
    seeded: row.job.seeded,
    fitScore: row.job.fitScore,
    scoreState: row.job.scoreState,
    scoreStateText: scoreStateText(row.job, now),
    fitVerdict: row.job.fitVerdict,
    fitRationale: row.job.fitRationale,
    keywordTerms: row.job.keywordTerms,
    addedByYou: row.job.origin === "user" && !!viewerId && row.job.addedBy === viewerId,
    decision: row.decision
      ? { id: row.decision.id, decision: row.decision.decision, reason: row.decision.reason, createdLabel: relativeTime(row.decision.createdAt, now), createdTitle: row.decision.createdAt.toISOString() }
      : null,
  };
}

/**
 * The freshness states a view narrows to, or null when it does not narrow at all: every role is new,
 * active or closed, so asking for all three (or, from a hand-written link, for none) filters nothing,
 * and would only cost a per-row expression the planner cannot estimate.
 */
function statusFilterOf(filters: Pick<RolesFilters, "status" | "closed">): string[] | null {
  const statuses = filters.closed ? [...new Set([...filters.status, "closed"])] : filters.status;
  return statuses.length === 0 || STATUS_VALUES.every((s) => statuses.includes(s)) ? null : statuses;
}

/**
 * The tab whose count is exactly this view's, or null when the view narrows below its tab.
 *
 * Only the tab itself, the company scope the counts are read for and the order may be set: once
 * those are taken out of the view's query string it must be empty, or the view is a subset and is
 * counted on its own. A filter added later reaches `filtersToQueryString`, and so falls back to its
 * own count unless someone decides otherwise here.
 */
export function tabCountedBy(filters: RolesFilters, archived: boolean): RoleStatus | null {
  const params = new URLSearchParams(filtersToQueryString(filters));
  for (const key of ["sort", "dir", "company", "decision"]) params.delete(key);
  if (statusFilterOf(filters) === null) { params.delete("status"); params.delete("closed"); }
  if (params.size > 0) return null;
  if (archived) return filters.decision === "all" ? "archived" : null;
  return filters.decision === "inbox" ? "auto-matched" : filters.decision === "apply" ? "user-shortlisted" : filters.decision === "skip" ? "user-dismissed" : null;
}

/**
 * Which tab's roles a view reads, as plain predicates on the columns `roleStatusSql` decides by, so
 * the planner can estimate them and `user_jobs_table_idx (user_id, in_table, archived_at, …)` can
 * serve them. Written through the `case` expression instead, the planner guessed 1–150 rows where
 * 10,000 came back and nested-looped every join. Equivalent to `roleStatusSql <> 'archived'` (or
 * `= 'archived'`), given the active-decision LEFT JOIN (a joined decision's `job_id` is the role's,
 * so it is null exactly when there is no active decision) and that `decisions.decision` is never null.
 */
function viewCondition(archived: boolean, decision: DecisionFilter): SQL | undefined {
  if (archived) return sql`(${userJobs.archivedAt} is not null or (not ${userJobs.inTable} and ${decisions.jobId} is null))`;
  // Undecided rows are in a live tab only while the gate admits them; a decided one, whatever the gate says.
  if (decision === "inbox" || decision === "undecided") return and(isNull(userJobs.archivedAt), sql`${userJobs.inTable}`);
  if (decision === "apply" || decision === "skip") return isNull(userJobs.archivedAt);
  return and(isNull(userJobs.archivedAt), sql`(${userJobs.inTable} or ${decisions.jobId} is not null)`);
}

/**
 * The one reading of a filtered view in SQL — the `where` and the `order by` the table, its counts
 * and the CSV export all share, so the file and the screen cannot disagree about which roles are in
 * a view or in what order (R-7.5). The page read applies both twice, to pick the page's keys and to
 * hydrate them (`fetchRoleRows`), and both come from here, so the two cannot drift apart.
 */
function rolesQuery(userId: string, filters: RolesFilters, archived: boolean, now: Date) {
  const liveStart = sql`case when ${jobs.postedAt} <= ${jobs.firstSeenAt} + interval '1 day' then ${jobs.postedAt} else ${jobs.firstSeenAt} end`;
  const status = sql`case when ${jobs.status} = 'closed' then 'closed' when ${liveStart} >= ${new Date(now.getTime() - 7 * 86400000)} then 'new' else 'active' end`;
  const statuses = statusFilterOf(filters);
  const cutoff = sinceCutoff(filters, now);
  const conditions = and(
    eq(userJobs.userId, userId),
    viewCondition(archived, filters.decision),
    statuses ? inArray(status, statuses) : undefined,
    // On the posting's own column, so the count needs no join to `companies` for it.
    filters.company ? eq(jobs.companyId, filters.company) : undefined,
    // "No active decision" on the column the join matches by, which PostgreSQL reads as an anti-join
    // and estimates; on `decisions.id` it was a filter after the join, guessed at one row in 10,000.
    filters.decision === 'inbox' || filters.decision === 'undecided' ? isNull(decisions.jobId) : filters.decision === 'apply' || filters.decision === 'skip' ? eq(decisions.decision, filters.decision) : undefined,
    filters.minFit !== null ? sql`${userJobs.fitScore} >= ${filters.minFit}` : undefined,
    filters.q ? sql`position(lower(${filters.q}) in lower(${jobs.title})) > 0` : undefined,
    filters.location ? sql`(position(lower(${filters.location}) in lower(coalesce(${jobs.location}, ''))) > 0 or exists (select 1 from jsonb_array_elements_text(${jobs.locations}) l where position(lower(${filters.location}) in lower(l)) > 0))` : undefined,
    // "This week": the window is on the decision, so an undecided role is never in a `since` view.
    cutoff ? sql`${decisions.createdAt} >= ${cutoff}` : undefined,
  );
  const sorts = {
    status: sql`case ${status} when 'new' then 0 when 'active' then 1 else 2 end`,
    fit: userJobs.fitScore, company: companies.name, firstSeen: jobs.firstSeenAt, title: jobs.title, location: sql`coalesce(${jobs.location}, '')`,
    decided: decisions.createdAt,
    liveFor: sql`greatest(0, floor(extract(epoch from (case when ${jobs.status} = 'closed' then coalesce(${jobs.closedAt}, ${now}) else ${now} end - (${liveStart}))) / 86400))`,
  };
  const dir: SortDir = filters.dir === 'desc' ? 'desc' : 'asc';
  const flip: SortDir = dir === 'asc' ? 'desc' : 'asc';
  // PostgreSQL's own default, written out: ascending puts nulls last and descending puts them first.
  const nullsByDefault = (d: SortDir) => (d === 'asc' ? 'last' : 'first');
  const keys: SortKeyPart[] = filters.sort === 'status'
    ? [
        { expr: sorts.status, dir, nulls: nullsByDefault(dir) },
        { expr: sql`${userJobs.fitScore}`, dir: flip, nulls: dir === 'asc' ? 'last' : 'first' },
        { expr: sql`${jobs.firstSeenAt}`, dir: flip, nulls: nullsByDefault(flip) },
        { expr: sql`${jobs.id}`, dir: 'asc', nulls: 'last' },
      ]
    : [
        { expr: sql`${sorts[filters.sort]}`, dir, nulls: 'last' },
        { expr: sql`${jobs.id}`, dir: 'asc', nulls: 'last' },
      ];
  const order = keys.map((key) => sql`${key.expr} ${sql.raw(key.dir)} nulls ${sql.raw(key.nulls)}`);
  // Each row's own values of the keys, as the database computed them: JSON keeps a timestamp to the
  // microsecond, which a JavaScript date would round and a keyset comparison would then get wrong.
  const cursor = sql<RoleCursor>`json_build_array(${sql.join(keys.map((key) => key.expr), sql`, `)})`;
  // The only key that reads a table the conditions do not: picking a page by company name needs it.
  const sortsByCompany = filters.sort === 'company';
  return { conditions, order, keys, cursor, sortsByCompany };
}

/** One key of a view's order: what is compared, which way, and where its nulls go. */
interface SortKeyPart {
  expr: SQL;
  dir: SortDir;
  nulls: "first" | "last";
}

/**
 * Where a block of a view ended: the last row's values of every sort key, `jobs.id` last, as
 * `fetchRoleRows` returned them on that row. Opaque to callers; only handed back as `after`.
 */
export type RoleCursor = readonly unknown[];

/**
 * The rows strictly after `cursor` in the view's order: after it on the first key where they
 * differ, with nulls placed exactly as the `order by` places them, so reading block after block
 * yields the order an offset read would, without the database skipping over what it has sent.
 */
function afterCursor(keys: SortKeyPart[], cursor: RoleCursor): SQL {
  if (cursor.length !== keys.length) throw new Error("A roles cursor must come from the same view.");
  let rest: SQL | undefined;
  for (let i = keys.length - 1; i >= 0; i--) {
    const { expr, dir, nulls } = keys[i]!;
    const value = cursor[i] ?? null;
    const op = sql.raw(dir === 'asc' ? '>' : '<');
    const beyond = value === null
      ? (nulls === 'first' ? sql`${expr} is not null` : sql`false`)
      : (nulls === 'last' ? sql`(${expr} ${op} ${value} or ${expr} is null)` : sql`${expr} ${op} ${value}`);
    const same = value === null ? sql`${expr} is null` : sql`${expr} = ${value}`;
    rest = rest ? sql`(${beyond} or (${same} and ${rest}))` : beyond;
  }
  return rest!;
}

/**
 * One block of a filtered view, at an offset or after a cursor, and of any size: the table reads 50
 * of these by page, the export reads them 500 at a time after the last row it wrote, until its cap.
 * Summary rows either way — nothing that renders a block renders the stored description, and 50 of
 * them is up to 1.5 MB read and serialised on every render and every pagination click.
 *
 * The block is read in one statement and two steps: the view's order and offset run over the narrow
 * keys (`user_jobs`, `jobs`, the active decision — and `companies` only when sorting by it), and
 * only the ids that survive are joined to the wide columns, the latest application and the stage.
 * Sorting every admitted row with all sixty columns attached is what made a deep page cost a quarter
 * of a second at 10,000 roles. The outer read repeats the same conditions and order from
 * `rolesQuery`, so the page is exactly what one statement over everything would return.
 *
 * Each row carries its `cursor`; passing the last one back as `after` reads the next block without
 * the database walking every row before it again, which an offset makes it do.
 */
export async function fetchRoleRows(userId: string, filters: RolesFilters, archived: boolean, { offset = 0, limit = 50, now = new Date(), after = null }: { offset?: number; limit?: number; now?: Date; after?: RoleCursor | null } = {}): Promise<Array<RoleRow & { cursor: RoleCursor }>> {
  const { conditions, order, keys, cursor, sortsByCompany } = rolesQuery(userId, filters, archived, now);
  const where = after ? and(conditions, afterCursor(keys, after)) : conditions;
  const narrow = db().select({ jobId: userJobs.jobId }).from(userJobs)
    .innerJoin(jobs, eq(jobs.id, userJobs.jobId))
    .leftJoin(decisions, and(eq(decisions.userId, userId), eq(decisions.jobId, jobs.id), eq(decisions.superseded, false)));
  const keysOfPage = (sortsByCompany ? narrow.innerJoin(companies, eq(jobs.companyId, companies.id)) : narrow)
    .where(where).orderBy(...order).limit(limit).offset(offset);
  const rows = await baseRolesSelect(userId, true, cursor)
    .where(and(sql`${jobs.id} in (select page_keys.job_id from (${keysOfPage}) page_keys)`, where))
    .orderBy(...order).limit(limit);
  return rows;
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
  /** "Archived: …" for each recent event that put this role away, newest first (`fetchArchiveNotes`). */
  archiveNotes: string[];
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

/**
 * How many roles a view's conditions admit, over only the tables they read: the account's view, the
 * posting and its active decision. The page read's joins to `companies`, `career_sources` and the
 * latest application add nothing here (the first two are required foreign keys, and at most one
 * active decision and one latest application exist per posting), but PostgreSQL cannot remove inner
 * joins, and counting through them cost 7.5 ms against 2.1 ms at 1,000 roles.
 */
export async function countRoles(userId: string, filters: RolesFilters, archived: boolean, now = new Date()): Promise<number> {
  const { conditions } = rolesQuery(userId, filters, archived, now);
  const [row] = await db().select({ n: sql<number>`count(*)::int` }).from(userJobs)
    .innerJoin(jobs, eq(jobs.id, userJobs.jobId))
    .leftJoin(decisions, and(eq(decisions.userId, userId), eq(decisions.jobId, jobs.id), eq(decisions.superseded, false)))
    .where(conditions);
  return row?.n ?? 0;
}

/**
 * SQL filters and pagination for one 50-row page; descriptions are left in the database. The count
 * and the page asked for are read side by side; only a page past the end of the view (a link
 * written before the view shrank) waits for the count and reads the last page instead.
 *
 * A view that is a whole tab (no filter but the tab, the company scope and the order) takes its
 * count from the tab counts, which the tab strip reads anyway and the request memoises, so the page
 * costs one statement rather than two; any narrower view is counted on its own.
 */
export async function fetchRolePage(userId: string, filters: RolesFilters, archived: boolean, threshold: number | null, requestedPage: number, now = new Date()) {
  const started = Date.now();
  const asked = Math.max(1, Number.isSafeInteger(requestedPage) ? requestedPage : 1);
  const tab = tabCountedBy(filters, archived);
  const [total, rows] = await Promise.all([
    tab ? fetchRoleCounts(userId, filters.company || undefined).then(counts => counts[tab]) : countRoles(userId, filters, archived, now),
    fetchRoleRows(userId, filters, archived, { offset: (asked - 1) * 50, limit: 50, now }),
  ]);
  // Fit is an explicit filter, never a second hidden workflow: nothing is ever held back.
  const hiddenTotal = 0;
  const pageCount = Math.max(1, Math.ceil(total / 50));
  const page = Math.min(pageCount, asked);
  const visible = page === asked ? rows : await fetchRoleRows(userId, filters, archived, { offset: (page - 1) * 50, limit: 50, now });
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

/**
 * How many of this account's roles sit under each tab, for the whole table or one company. Kept for
 * the request: the roles page's setup card and its workspace both ask for the whole table's.
 */
export function fetchRoleCounts(userId: string, companyId?: string): Promise<Record<RoleStatus, number>> {
  return roleCountsFor(userId, companyId || null);
}

const roleCountsFor = cache(async (userId: string, companyId: string | null): Promise<Record<RoleStatus, number>> => {
  const rows = await db().select({ status: roleStatusSql, n: sql<number>`count(*)::int` }).from(userJobs)
    .innerJoin(jobs, eq(jobs.id, userJobs.jobId))
    .leftJoin(decisions, and(eq(decisions.userId, userId), eq(decisions.jobId, jobs.id), eq(decisions.superseded, false)))
    .where(and(eq(userJobs.userId, userId), companyId ? eq(jobs.companyId, companyId) : undefined)).groupBy(roleStatusSql);
  const counts = Object.fromEntries(ROLE_STATUSES.map(status => [status, 0])) as Record<RoleStatus, number>;
  for (const row of rows) counts[row.status] = row.n;
  return counts;
});
