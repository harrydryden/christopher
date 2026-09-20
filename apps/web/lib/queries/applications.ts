/**
 * The applications table: every company-role this account is pursuing, whatever stage it has
 * reached, in one list.
 *
 * Two things can say a role is being pursued, and they are stored apart. Nearly always it is the
 * account's own `user_jobs` view of a shared posting, whose stage `roleStageSql` reads from the
 * decision, the CV and the newest application together. But an application recorded before
 * applications carried a `job_id`, or a CV built for a company that has since been deleted from
 * the catalogue, has no view to read — and those are exactly the rows a person would miss first.
 * So they are gathered separately and keyed by `cvRoleKey`, the same company-and-role identity the
 * CV retention rules use, which is what makes one company-role one row on either side.
 *
 * Both sides meet in one `union all` — the **index**: one row per pursued company-role carrying
 * only what it takes to count, order and page it (its key, its stage and when it last moved).
 * Counting and paging happen there, in SQL, so an account with a thousand applications reads a
 * page of fifty rather than all of them; only the keys the page actually shows are then hydrated
 * into full rows. The stage on each side is the same expression the rest of the product reads —
 * `roleStageSql` for a posting, `applicationStage` compiled into SQL for a record without one — so
 * the count, the order and the row can never disagree about where a role has got to.
 */
import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  applications,
  companies,
  cvDrafts,
  cvRoleKey,
  decisions,
  jobs,
  latestApplicationFor,
  roleStageSql,
  userJobs,
  type ApplicationStatus,
} from "@christopher/db";
import {
  ACTIVE_ROLE_STAGES,
  APPLICATION_STATUSES,
  CLOSED_ROLE_STAGES,
  ROLE_STAGES,
  aiBudgetRefusalMessage,
  applicationStage,
  roleStageRank,
  type RoleStage,
} from "@christopher/core";
import { DUE_WITHIN_DAYS, todayDay } from "@/lib/application-dates";
import { companyIcon } from "@/lib/company-icon";
import { cvBuildQuote, cvEditCosts, type CvBuildQuote } from "@/lib/cv-quote";
import { db } from "@/lib/db";
import { getSettingsFor } from "@/lib/settings";
import { pageNumber } from "@/components/Pagination";

export const PIPELINE_FILTERS = ["active", "closed", "all"] as const;
export type PipelineFilter = (typeof PIPELINE_FILTERS)[number];

export const PIPELINE_FILTER_LABELS: Record<PipelineFilter, string> = {
  active: "Active",
  closed: "Closed",
  all: "All",
};

const STAGES_BY_FILTER: Record<PipelineFilter, readonly RoleStage[]> = {
  active: ACTIVE_ROLE_STAGES,
  closed: CLOSED_ROLE_STAGES,
  all: [...ACTIVE_ROLE_STAGES, ...CLOSED_ROLE_STAGES],
};

/** Whichever of the three segments a link asks for; anything else is the default, Active. */
export function pipelineFilter(raw?: string | string[]): PipelineFilter {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return PIPELINE_FILTERS.find((filter) => filter === value) ?? "active";
}

export type CvStatus = "queued" | "generating" | "ready" | "failed";

export interface PipelineCv {
  id: string;
  status: CvStatus;
  revision: number;
  finalisedAt: Date | null;
  createdAt: Date;
}

export interface PipelineApplication {
  id: string;
  status: ApplicationStatus;
  appliedOn: string;
  cvId: string | null;
  notes: string;
  /** `at` is when the entry was saved; `on` is the day it is about, when the person gave one. */
  history: Array<{ status: string; at: string; notes: string; on?: string }>;
  /** What the person owes this application next, in their own words, and the day it is due. */
  nextAction: string | null;
  nextActionOn: string | null;
  /** Whether the row stores the submitted PDF, which is what makes it downloadable. */
  hasPdf: boolean;
}

export interface PipelineRow {
  /** The posting's id, or the role key for a row with no posting behind it. Identifies the row. */
  key: string;
  jobId: string | null;
  companyId: string | null;
  companyName: string;
  /** Null for a legacy row: there is no catalogue company to take an icon from. */
  companyIcon: { src: string | null; domain: string } | null;
  jobTitle: string;
  jobUrl: string | null;
  stage: RoleStage;
  application: PipelineApplication | null;
  cv: PipelineCv | null;
  /** The retained predecessor of the current CV: what "Restore previous CV" puts back. */
  archivedCvId: string | null;
  updatedAt: Date;
}

export interface PipelinePage {
  rows: PipelineRow[];
  page: number;
  pageCount: number;
  total: number;
  counts: Record<PipelineFilter, number>;
  /** The same reading one stage at a time, for the strip in the page's header. */
  stages: Record<RoleStage, number>;
}

/** The catalogue company a `?company=` link names: shared data, so it is read without an account. */
export interface PipelineCompany {
  id: string;
  name: string;
}

/**
 * A quote as the row shows it: already sentences. The table is a client component, and the
 * pricing it quotes is read from the database, so what crosses that line is the words.
 */
export interface PipelineCvQuote {
  /** "about $3.10 of your $18.40 left this month". */
  line: string;
  /** The budget's refusal, which disables the control, or null when the estimate fits. */
  refusal: string | null;
}

const PAGE_SIZE = 50;

/**
 * One account's newest live CV per posting, as a subquery to LEFT JOIN on — the shape
 * `latestApplicationFor` has for applications. An archived predecessor is left out: it is not the
 * role's current CV, and whether one exists is asked separately.
 */
function currentCvFor(userId: string) {
  return new QueryBuilder()
    .selectDistinctOn([cvDrafts.jobId], {
      jobId: cvDrafts.jobId,
      id: cvDrafts.id,
      status: cvDrafts.status,
      revision: cvDrafts.revision,
      finalisedAt: cvDrafts.finalisedAt,
      createdAt: cvDrafts.createdAt,
    })
    .from(cvDrafts)
    .where(and(eq(cvDrafts.userId, userId), isNull(cvDrafts.archivedAt), isNotNull(cvDrafts.jobId)))
    .orderBy(cvDrafts.jobId, desc(cvDrafts.createdAt), desc(cvDrafts.id))
    .as("current_cv");
}

/**
 * A record with no view behind it: no `job_id` at all, or one whose posting this account does not
 * have a `user_jobs` row for — a company deleted from the catalogue, or a record written before
 * applications carried the link. Written against whichever table's `job_id` column is passed.
 */
function withoutRoleView(userId: string, jobIdColumn: AnyColumn) {
  return sql`(${jobIdColumn} is null or not exists (
    select 1 from ${userJobs} v where v.user_id = ${userId} and v.job_id = ${jobIdColumn}))`;
}

/** The moment a row last moved: its newest history entry, else when the application was written. */
function applicationMovedAt(row: { createdAt: Date; history: Array<{ at: string }> }): Date {
  let latest = row.createdAt.getTime();
  for (const entry of row.history) {
    const at = Date.parse(entry.at);
    if (Number.isFinite(at) && at > latest) latest = at;
  }
  return new Date(latest);
}

/**
 * The same reading in SQL, for the index. Only entries that look like the ISO instants this
 * product writes are cast, so a hand-edited history can never fail the whole page on a cast.
 */
const applicationMovedAtSql = sql`greatest(${applications.createdAt}, (
  select max((entry->>'at')::timestamptz) from jsonb_array_elements(${applications.history}) entry
  where entry->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'))`;

function newest(...times: Array<Date | null | undefined>): Date | null {
  let best: Date | null = null;
  for (const time of times) if (time && (!best || time.getTime() > best.getTime())) best = time;
  return best;
}

/**
 * `applicationStage()` as a SQL CASE, generated from the function itself so the stage a record
 * with no posting is counted under cannot drift from the stage it is rendered at. The fallback
 * matches `roleStageSql`: a status this build does not know is still an application on record.
 */
function applicationStageCase(column: SQL | AnyColumn): SQL {
  const arms = APPLICATION_STATUSES.map((status) => `when '${status}' then '${applicationStage(status)}'`).join(" ");
  return sql`case ${column} ${sql.raw(arms)} else 'applied' end`;
}

/** `roleStageRank()` as a SQL CASE, generated from `ROLE_STAGES` for the same reason. */
const STAGE_RANK_CASE = sql.raw(
  `case stage ${ROLE_STAGES.map((stage, rank) => `when '${stage}' then ${rank}`).join(" ")} else ${ROLE_STAGES.length} end`,
);

/** Company names compare the way `cvRoleKey` compares them: case- and whitespace-insensitive. */
function sameCompanyName(column: AnyColumn, name: string): SQL {
  const normalise = (value: SQL | AnyColumn) => sql`lower(btrim(regexp_replace(${value}, '[[:space:]]+', ' ', 'g')))`;
  return sql`${normalise(column)} = ${normalise(sql`${name}::text`)}`;
}

/**
 * Every pursued role this account has that the catalogue still knows about, as index rows.
 *
 * A role merely passed on from Roles was never pursued and has no business here; a dismissed role
 * is listed only when something was done about it — an application row (withdrawn, or dismissed
 * after applying) or a CV, archived or not.
 */
function roleIndex(userId: string, company?: PipelineCompany) {
  const latest = latestApplicationFor(userId);
  const currentCv = currentCvFor(userId);
  const stage = roleStageSql(latest, userId);
  return db()
    .select({
      key: sql<string>`${jobs.id}::text`.as("key"),
      stage: sql<string>`${stage}`.as("stage"),
      // A role archived by a narrowed gate has neither a decision nor an application, so the
      // view's own last change is what is left to date it by.
      updatedAt: sql<Date>`coalesce(greatest(${decisions.createdAt}, ${applicationMovedAtSql}, ${currentCv.createdAt}), ${userJobs.updatedAt})`.as("updated_at"),
    })
    .from(userJobs)
    .innerJoin(jobs, eq(jobs.id, userJobs.jobId))
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .leftJoin(decisions, and(eq(decisions.userId, userId), eq(decisions.jobId, jobs.id), eq(decisions.superseded, false)))
    .leftJoin(latest, eq(latest.jobId, jobs.id))
    .leftJoin(applications, eq(applications.id, latest.id))
    .leftJoin(currentCv, eq(currentCv.jobId, jobs.id))
    .where(and(
      eq(userJobs.userId, userId),
      company ? eq(companies.id, company.id) : undefined,
      ne(stage, "matched"),
      or(ne(stage, "dismissed"), isNotNull(latest.id), sql`exists (select 1 from ${cvDrafts} pursued where pursued.user_id = ${userId} and pursued.job_id = ${jobs.id})`),
    ))
    .as("role_index");
}

/**
 * The same, for records with no posting behind them: the newest application per role key, full
 * outer joined to the newest live CV per role key. A key with neither — one that only ever carried
 * an archived CV — falls out of the join, which is what "nothing current to show" means here.
 */
function legacyIndex(userId: string, company?: PipelineCompany) {
  // The key is built once, in an inner select, so `distinct on` and `order by` are the same
  // expression rather than two copies of it carrying different bind parameters.
  const applicationRows = db()
    .select({
      key: sql<string>`${cvRoleKey(userId, applications.companyName, applications.jobTitle)}`.as("key"),
      stage: sql<string>`${applicationStageCase(applications.status)}`.as("stage"),
      movedAt: sql<Date>`${applicationMovedAtSql}`.as("moved_at"),
      createdAt: applications.createdAt,
      id: applications.id,
    })
    .from(applications)
    .where(and(
      eq(applications.userId, userId),
      withoutRoleView(userId, applications.jobId),
      company ? sameCompanyName(applications.companyName, company.name) : undefined,
    ))
    .as("legacy_app_rows");
  const application = db()
    .selectDistinctOn([applicationRows.key], { key: applicationRows.key, stage: applicationRows.stage, movedAt: applicationRows.movedAt })
    .from(applicationRows)
    .orderBy(applicationRows.key, desc(applicationRows.createdAt), desc(applicationRows.id))
    .as("legacy_app");
  const draftRows = db()
    .select({
      key: sql<string>`${cvRoleKey(userId, cvDrafts.companyName, cvDrafts.jobTitle)}`.as("key"),
      createdAt: cvDrafts.createdAt,
      id: cvDrafts.id,
    })
    .from(cvDrafts)
    .where(and(
      eq(cvDrafts.userId, userId),
      withoutRoleView(userId, cvDrafts.jobId),
      isNull(cvDrafts.archivedAt),
      company ? sameCompanyName(cvDrafts.companyName, company.name) : undefined,
    ))
    .as("legacy_cv_rows");
  const draft = db()
    .selectDistinctOn([draftRows.key], { key: draftRows.key, createdAt: draftRows.createdAt })
    .from(draftRows)
    .orderBy(draftRows.key, desc(draftRows.createdAt), desc(draftRows.id))
    .as("legacy_cv");
  return { application, draft };
}

/** The two sides as one list of index rows, which is what counting and paging read. */
function pipelineIndex(userId: string, company?: PipelineCompany): SQL {
  const role = roleIndex(userId, company);
  const { application, draft } = legacyIndex(userId, company);
  return sql`
    select 'role' as source, role_index."key" as key, role_index."stage" as stage, role_index."updated_at" as updated_at
      from ${role}
    union all
    select 'legacy' as source,
           coalesce(legacy_app."key", legacy_cv."key") as key,
           coalesce(legacy_app."stage", 'applying') as stage,
           greatest(coalesce(legacy_app."moved_at", to_timestamp(0)), coalesce(legacy_cv."created_at", to_timestamp(0))) as updated_at
      from ${application} full join ${draft} on legacy_app."key" = legacy_cv."key"`;
}

const NO_STAGE_COUNTS = (): Record<RoleStage, number> =>
  Object.fromEntries(ROLE_STAGES.map((stage) => [stage, 0])) as Record<RoleStage, number>;

/**
 * How many pursued roles this account has at each stage, counted in SQL.
 *
 * The Applications page's own segment counts come from here, and the roles table can read the same
 * numbers for a breakdown of its Shortlisted tab ("Shortlisted 12 · 3 applied") without a second
 * reading of the lifecycle. `matched` is always zero: a matched role is not being pursued.
 */
export async function pipelineStageCounts(
  userId: string,
  options: { company?: PipelineCompany } = {},
): Promise<Record<RoleStage, number>> {
  const rows = await db().execute<{ stage: string; n: number }>(
    sql`select stage, count(*)::int as n from (${pipelineIndex(userId, options.company)}) idx group by stage`,
  );
  const counts = NO_STAGE_COUNTS();
  for (const row of rows.rows) if (row.stage in counts) counts[row.stage as RoleStage] = Number(row.n);
  return counts;
}

/** The statuses an application is finished at, read from the lifecycle rather than listed again. */
const SETTLED_STATUSES = APPLICATION_STATUSES.filter((status) =>
  (CLOSED_ROLE_STAGES as readonly RoleStage[]).includes(applicationStage(status)),
);

/**
 * How many next steps this account owes in the coming week, for the line under the stage strip.
 *
 * Overdue ones are counted too: a step whose day has gone by is the most due thing on the page,
 * and the row it belongs to says so in its own words. A settled application — accepted, rejected,
 * withdrawn — owes nothing however old its note is. One indexed count, scoped to the same company
 * a `?company=` link scopes the table to: by its catalogue id for a role with a posting behind it,
 * and by name for a record without one, exactly as the table's own filter reads it.
 */
export async function pipelineDueCount(
  userId: string,
  options: { company?: PipelineCompany; now?: Date } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const horizon = new Date(Date.parse(`${todayDay(now)}T00:00:00.000Z`) + DUE_WITHIN_DAYS * 86_400_000).toISOString().slice(0, 10);
  const settled = sql.raw(SETTLED_STATUSES.map((status) => `'${status}'`).join(", "));
  const company = options.company;
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(applications)
    .where(and(
      eq(applications.userId, userId),
      sql`btrim(coalesce(${applications.nextAction}, '')) <> ''`,
      sql`${applications.nextActionOn} is not null and ${applications.nextActionOn} <= ${horizon}`,
      sql`${applications.status} not in (${settled})`,
      company
        ? sql`(exists (select 1 from ${jobs} due_job where due_job.id = ${applications.jobId} and due_job.company_id = ${company.id})
            or (${withoutRoleView(userId, applications.jobId)} and ${sameCompanyName(applications.companyName, company.name)}))`
        : undefined,
    ));
  return Number(row?.n ?? 0);
}

/** Rows this account is pursuing that the catalogue still knows about: the ordinary case. */
async function roleRows(userId: string, only: { jobId?: string; jobIds?: string[] } = {}): Promise<PipelineRow[]> {
  if (only.jobIds?.length === 0) return [];
  const latest = latestApplicationFor(userId);
  const currentCv = currentCvFor(userId);
  const stage = roleStageSql(latest, userId);
  const rows = await db()
    .select({
      jobId: jobs.id,
      jobTitle: jobs.title,
      jobUrl: jobs.url,
      companyId: companies.id,
      companyName: companies.name,
      faviconUrl: companies.faviconUrl,
      companyDomain: companies.domain,
      logoFetchedAt: companies.logoFetchedAt,
      stage,
      viewUpdatedAt: userJobs.updatedAt,
      decidedAt: decisions.createdAt,
      applicationId: latest.id,
      applicationStatus: latest.status,
      appliedOn: latest.appliedOn,
      applicationCvId: latest.cvId,
      applicationCreatedAt: latest.createdAt,
      notes: applications.notes,
      history: applications.history,
      nextAction: applications.nextAction,
      nextActionOn: applications.nextActionOn,
      hasPdf: sql<boolean>`${applications.pdfBase64} is not null`,
      cvId: currentCv.id,
      cvStatus: currentCv.status,
      cvRevision: currentCv.revision,
      cvFinalisedAt: currentCv.finalisedAt,
      cvCreatedAt: currentCv.createdAt,
      archivedCvId: sql<string | null>`(select previous.id from ${cvDrafts} previous
        where previous.user_id = ${userId} and previous.job_id = ${jobs.id} and previous.archived_at is not null
        order by previous.archived_at desc, previous.id desc limit 1)`,
    })
    .from(userJobs)
    .innerJoin(jobs, eq(jobs.id, userJobs.jobId))
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .leftJoin(decisions, and(eq(decisions.userId, userId), eq(decisions.jobId, jobs.id), eq(decisions.superseded, false)))
    .leftJoin(latest, eq(latest.jobId, jobs.id))
    // The application row the subquery chose, for the fields the table and its row expansion need
    // beyond the stage. The PDF is asked about, never read: the bytes belong to the download route.
    .leftJoin(applications, eq(applications.id, latest.id))
    .leftJoin(currentCv, eq(currentCv.jobId, jobs.id))
    // A role merely passed on from Roles was never pursued and has no business here; a dismissed
    // role is listed only when something was done about it — an application row (withdrawn, or
    // dismissed after applying) or a CV, archived or not.
    .where(and(
      eq(userJobs.userId, userId),
      only.jobId ? eq(jobs.id, only.jobId) : undefined,
      only.jobIds ? inArray(jobs.id, only.jobIds) : undefined,
      ne(stage, "matched"),
      or(ne(stage, "dismissed"), isNotNull(latest.id), sql`exists (select 1 from ${cvDrafts} pursued where pursued.user_id = ${userId} and pursued.job_id = ${jobs.id})`),
    ));

  return rows.map((row) => {
    const application: PipelineApplication | null = row.applicationId
      ? {
          id: row.applicationId,
          status: row.applicationStatus as ApplicationStatus,
          appliedOn: row.appliedOn ?? "",
          cvId: row.applicationCvId,
          notes: row.notes ?? "",
          history: row.history ?? [],
          nextAction: row.nextAction,
          nextActionOn: row.nextActionOn,
          hasPdf: !!row.hasPdf,
        }
      : null;
    const cv: PipelineCv | null = row.cvId
      ? { id: row.cvId, status: row.cvStatus as CvStatus, revision: row.cvRevision ?? 0, finalisedAt: row.cvFinalisedAt, createdAt: row.cvCreatedAt! }
      : null;
    return {
      key: row.jobId,
      jobId: row.jobId,
      companyId: row.companyId,
      companyName: row.companyName,
      companyIcon: companyIcon({ id: row.companyId, faviconUrl: row.faviconUrl, domain: row.companyDomain, logoFetchedAt: row.logoFetchedAt }),
      jobTitle: row.jobTitle,
      jobUrl: row.jobUrl,
      stage: row.stage as RoleStage,
      application,
      cv,
      archivedCvId: row.archivedCvId,
      // A role archived by a narrowed gate has neither a decision nor an application, so the
      // view's own last change is what is left to date it by.
      updatedAt:
        newest(
          row.decidedAt,
          application && applicationMovedAt({ createdAt: row.applicationCreatedAt!, history: application.history }),
          cv?.createdAt,
        ) ?? row.viewUpdatedAt,
    } satisfies PipelineRow;
  });
}

/**
 * Rows with no posting behind them, one per company-role. The newest application decides the
 * stage; with only a CV the role is being applied for, which is the earliest stage a record of it
 * can mean. Never `matched`: nothing here came through the gate.
 */
async function legacyRows(userId: string, only: { keys?: string[] } = {}): Promise<PipelineRow[]> {
  if (only.keys?.length === 0) return [];
  const applicationKey = cvRoleKey(userId, applications.companyName, applications.jobTitle);
  const draftKey = cvRoleKey(userId, cvDrafts.companyName, cvDrafts.jobTitle);
  const [applicationRows, draftRows] = await Promise.all([
    db()
      .select({
        key: applicationKey,
        id: applications.id,
        status: applications.status,
        appliedOn: applications.appliedOn,
        cvId: applications.cvId,
        notes: applications.notes,
        history: applications.history,
        nextAction: applications.nextAction,
        nextActionOn: applications.nextActionOn,
        hasPdf: sql<boolean>`${applications.pdfBase64} is not null`,
        companyName: applications.companyName,
        jobTitle: applications.jobTitle,
        createdAt: applications.createdAt,
      })
      .from(applications)
      .where(and(
        eq(applications.userId, userId),
        withoutRoleView(userId, applications.jobId),
        only.keys ? inArray(applicationKey, only.keys) : undefined,
      ))
      .orderBy(desc(applications.createdAt), desc(applications.id)),
    db()
      .select({
        key: draftKey,
        id: cvDrafts.id,
        status: cvDrafts.status,
        revision: cvDrafts.revision,
        finalisedAt: cvDrafts.finalisedAt,
        createdAt: cvDrafts.createdAt,
        companyName: cvDrafts.companyName,
        jobTitle: cvDrafts.jobTitle,
        archived: sql<boolean>`${cvDrafts.archivedAt} is not null`,
      })
      .from(cvDrafts)
      .where(and(
        eq(cvDrafts.userId, userId),
        withoutRoleView(userId, cvDrafts.jobId),
        only.keys ? inArray(draftKey, only.keys) : undefined,
      ))
      .orderBy(desc(cvDrafts.createdAt), desc(cvDrafts.id)),
  ]);

  const byKey = new Map<string, PipelineRow>();
  const ensure = (key: string, companyName: string, jobTitle: string): PipelineRow => {
    const existing = byKey.get(key);
    if (existing) return existing;
    const created: PipelineRow = {
      key, jobId: null, companyId: null, companyName, companyIcon: null, jobTitle, jobUrl: null,
      stage: "applying", application: null, cv: null, archivedCvId: null, updatedAt: new Date(0),
    };
    byKey.set(key, created);
    return created;
  };
  // Both lists are newest first, so the first row seen for a key is the one that counts.
  for (const row of applicationRows) {
    const entry = ensure(row.key, row.companyName, row.jobTitle);
    if (entry.application) continue;
    entry.application = {
      id: row.id, status: row.status, appliedOn: row.appliedOn, cvId: row.cvId,
      notes: row.notes, history: row.history, nextAction: row.nextAction, nextActionOn: row.nextActionOn,
      hasPdf: !!row.hasPdf,
    };
    entry.stage = applicationStage(row.status);
    entry.updatedAt = newest(entry.updatedAt, applicationMovedAt(row))!;
  }
  for (const row of draftRows) {
    const entry = ensure(row.key, row.companyName, row.jobTitle);
    if (row.archived) { entry.archivedCvId ??= row.id; continue; }
    if (entry.cv) continue;
    entry.cv = { id: row.id, status: row.status, revision: row.revision, finalisedAt: row.finalisedAt, createdAt: row.createdAt };
    entry.updatedAt = newest(entry.updatedAt, row.createdAt)!;
  }
  // A key that only ever carried an archived CV has nothing current to show.
  return [...byKey.values()].filter((row) => row.application || row.cv);
}

/**
 * One role's row as the table would show it now, or null when the role is not in the pipeline
 * (matched, or merely passed on). A CV action returns this so the row can follow the database
 * without waiting for the page to be rendered again.
 */
export async function pipelineRowForJob(userId: string, jobId: string): Promise<PipelineRow | null> {
  return (await roleRows(userId, { jobId }))[0] ?? null;
}

/** The catalogue company a `?company=` filter names. Shared data, so no account scopes the read. */
export async function pipelineCompany(companyId: string): Promise<PipelineCompany | null> {
  const [row] = await db().select({ id: companies.id, name: companies.name }).from(companies).where(eq(companies.id, companyId)).limit(1);
  return row ?? null;
}

/**
 * Every company-role this account is pursuing, ordered the way it is worked: by how far it has
 * got, and within a stage by what moved most recently.
 *
 * Counted and paged in the index, then hydrated for the fifty keys the page shows.
 */
export async function listPipeline(
  userId: string,
  options: { filter?: PipelineFilter; page?: string | number; company?: PipelineCompany } = {},
): Promise<PipelinePage> {
  const filter = options.filter ?? "active";
  const stageCounts = await pipelineStageCounts(userId, { company: options.company });
  const counts: Record<PipelineFilter, number> = { active: 0, closed: 0, all: 0 };
  for (const stage of ROLE_STAGES) {
    counts.all += stageCounts[stage];
    if ((ACTIVE_ROLE_STAGES as readonly RoleStage[]).includes(stage)) counts.active += stageCounts[stage];
    else if ((CLOSED_ROLE_STAGES as readonly RoleStage[]).includes(stage)) counts.closed += stageCounts[stage];
  }
  const wanted = STAGES_BY_FILTER[filter];
  const total = wanted.reduce((sum, stage) => sum + stageCounts[stage], 0);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(pageNumber(options.page === undefined ? undefined : String(options.page)), pageCount);
  if (total === 0) return { rows: [], page, pageCount, total, counts, stages: stageCounts };
  const wantedList = sql.raw(wanted.map((stage) => `'${stage}'`).join(", "));
  const keys = await db().execute<{ source: string; key: string }>(sql`
    select source, key from (${pipelineIndex(userId, options.company)}) idx
    where stage in (${wantedList})
    order by ${STAGE_RANK_CASE}, updated_at desc, key
    limit ${PAGE_SIZE} offset ${(page - 1) * PAGE_SIZE}`);
  const order = keys.rows.map((row) => row.key);
  const [roles, legacy] = await Promise.all([
    roleRows(userId, { jobIds: keys.rows.filter((row) => row.source === "role").map((row) => row.key) }),
    legacyRows(userId, { keys: keys.rows.filter((row) => row.source === "legacy").map((row) => row.key) }),
  ]);
  const hydrated = new Map([...roles, ...legacy].map((row) => [row.key, row]));
  // The index decided the order; a key it listed that hydration cannot find changed underneath
  // this read and is left out rather than rendered half-empty.
  const rows = order.flatMap((key) => (hydrated.has(key) ? [hydrated.get(key)!] : []));
  return { rows, page, pageCount, total, counts, stages: stageCounts };
}

/**
 * "No update for 3 weeks", for a row that is waiting on somebody. A hint, not a reminder: the
 * product sends nothing, and the sentence is only offered where the person is already looking.
 * Only the two stages where silence means something — an application sent, or an employer
 * considering it — carry it; a shortlist nobody has acted on is not stale, it is untouched.
 */
export function applicationStaleHint(row: Pick<PipelineRow, "stage" | "updatedAt">, now: Date = new Date()): string | null {
  if (row.stage !== "applied" && row.stage !== "in_process") return null;
  const days = Math.floor((now.getTime() - new Date(row.updatedAt).getTime()) / 86_400_000);
  if (days < 14) return null;
  return `No update for ${Math.floor(days / 7)} weeks`;
}

/**
 * What a CV build would cost for each role on the page, before the button is pressed.
 *
 * The account's side of the sum — its Library, its spend, its holds, its limit — is the same for
 * every row, so it is read once through `cvBuildQuote` and only the description varies per role.
 * Fifty rows therefore cost one quote and one measurement query rather than fifty of each. Rows
 * with no posting behind them have nothing to build from and get no quote.
 */
export async function pipelineCvQuotes(
  userId: string,
  rows: Array<Pick<PipelineRow, "jobId">>,
  now: Date = new Date(),
): Promise<Record<string, CvBuildQuote>> {
  const jobIds = [...new Set(rows.flatMap((row) => (row.jobId ? [row.jobId] : [])))];
  if (!jobIds.length) return {};
  const [settings, account, sizes] = await Promise.all([
    getSettingsFor(userId),
    cvBuildQuote(userId, jobIds[0]!, now),
    db()
      .select({ jobId: jobs.id, bytes: sql<number>`octet_length(coalesce(${jobs.descriptionText}, ''))::int` })
      .from(userJobs)
      .innerJoin(jobs, eq(jobs.id, userJobs.jobId))
      .where(and(eq(userJobs.userId, userId), inArray(jobs.id, jobIds))),
  ]);
  const bytes = new Map(sizes.map((row) => [row.jobId, Number(row.bytes)]));
  const quotes: Record<string, CvBuildQuote> = {};
  for (const jobId of jobIds) {
    const estimateUsd = cvEditCosts(settings.cvModel, {
      libraryBytes: account.libraryBytes,
      descriptionBytes: bytes.get(jobId) ?? 0,
    }).allUsd;
    const fits = account.spentUsd + account.heldUsd + estimateUsd <= account.limitUsd;
    quotes[jobId] = {
      ...account,
      estimateUsd,
      refusal: fits
        ? null
        : aiBudgetRefusalMessage("This build", estimateUsd, {
            limit: "account",
            limitUsd: account.limitUsd,
            spent: account.spentUsd,
            held: account.heldUsd,
          }),
    };
  }
  return quotes;
}
