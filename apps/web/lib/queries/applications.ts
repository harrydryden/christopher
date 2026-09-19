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
 * Both sides are merged, counted and paged in JS, like `fetchRolePage` does for the roles table:
 * the set is one account's pursued roles, and the columns read are small.
 */
import { and, desc, eq, isNotNull, isNull, ne, or, sql, type AnyColumn } from "drizzle-orm";
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
  CLOSED_ROLE_STAGES,
  applicationStage,
  roleStageRank,
  type RoleStage,
} from "@christopher/core";
import { companyIcon } from "@/lib/company-icon";
import { db } from "@/lib/db";
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
  history: Array<{ status: string; at: string; notes: string }>;
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

function newest(...times: Array<Date | null | undefined>): Date | null {
  let best: Date | null = null;
  for (const time of times) if (time && (!best || time.getTime() > best.getTime())) best = time;
  return best;
}

/** Rows this account is pursuing that the catalogue still knows about: the ordinary case. */
async function roleRows(userId: string, onlyJobId?: string): Promise<PipelineRow[]> {
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
      onlyJobId ? eq(jobs.id, onlyJobId) : undefined,
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
async function legacyRows(userId: string): Promise<PipelineRow[]> {
  const [applicationRows, draftRows] = await Promise.all([
    db()
      .select({
        key: cvRoleKey(userId, applications.companyName, applications.jobTitle),
        id: applications.id,
        status: applications.status,
        appliedOn: applications.appliedOn,
        cvId: applications.cvId,
        notes: applications.notes,
        history: applications.history,
        hasPdf: sql<boolean>`${applications.pdfBase64} is not null`,
        companyName: applications.companyName,
        jobTitle: applications.jobTitle,
        createdAt: applications.createdAt,
      })
      .from(applications)
      .where(and(eq(applications.userId, userId), withoutRoleView(userId, applications.jobId)))
      .orderBy(desc(applications.createdAt), desc(applications.id)),
    db()
      .select({
        key: cvRoleKey(userId, cvDrafts.companyName, cvDrafts.jobTitle),
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
      .where(and(eq(cvDrafts.userId, userId), withoutRoleView(userId, cvDrafts.jobId)))
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
      notes: row.notes, history: row.history, hasPdf: !!row.hasPdf,
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
 * Every company-role this account is pursuing, ordered the way it is worked: by how far it has
 * got, and within a stage by what moved most recently.
 */
/**
 * One role's row as the table would show it now, or null when the role is not in the pipeline
 * (matched, or merely passed on). A CV action returns this so the row can follow the database
 * without waiting for the page to be rendered again.
 */
export async function pipelineRowForJob(userId: string, jobId: string): Promise<PipelineRow | null> {
  return (await roleRows(userId, jobId))[0] ?? null;
}

export async function listPipeline(
  userId: string,
  options: { filter?: PipelineFilter; page?: string | number } = {},
): Promise<PipelinePage> {
  const filter = options.filter ?? "active";
  const [roles, legacy] = await Promise.all([roleRows(userId), legacyRows(userId)]);
  const all = [...roles, ...legacy];
  const counts: Record<PipelineFilter, number> = { active: 0, closed: 0, all: all.length };
  for (const row of all) {
    if ((ACTIVE_ROLE_STAGES as readonly RoleStage[]).includes(row.stage)) counts.active += 1;
    else if ((CLOSED_ROLE_STAGES as readonly RoleStage[]).includes(row.stage)) counts.closed += 1;
  }
  const wanted = STAGES_BY_FILTER[filter];
  const matching = all
    .filter((row) => wanted.includes(row.stage))
    .sort((a, b) =>
      roleStageRank(a.stage) - roleStageRank(b.stage) ||
      b.updatedAt.getTime() - a.updatedAt.getTime() ||
      a.key.localeCompare(b.key));
  const total = matching.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(pageNumber(options.page === undefined ? undefined : String(options.page)), pageCount);
  return { rows: matching.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), page, pageCount, total, counts };
}
