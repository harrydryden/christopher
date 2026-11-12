import Link from "next/link";
import { z } from "zod";
import { ROLE_STAGES, ROLE_STAGE_LABELS, type RoleStage } from "@col/core";
import { ApplicationsTable } from "@/components/ApplicationsTable";
import { AutoRefresh } from "@/components/AutoRefresh";
import { getCvWorkStatus } from "@/lib/work-status";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Pagination } from "@/components/Pagination";
import { buttonLinkClass } from "@/components/Button";
import { nextStep } from "@/lib/application-dates";
import { requireUser } from "@/lib/auth";
import {
  applicationStaleHint,
  listPipeline,
  pipelineCompany,
  pipelineFilter,
  PIPELINE_FILTERS,
  PIPELINE_FILTER_LABELS,
  type PipelineFocus,
} from "@/lib/queries/applications";

export const dynamic = "force-dynamic";

/**
 * The stages the header strip counts: the ones an application passes through, in order. Matched
 * is never here (a matched role is not being pursued) and the two the strip leaves out —
 * Shortlisted and Dismissed — are what the Active and Closed segments below it are for.
 */
const STRIP_STAGES: readonly RoleStage[] = ["applying", "applied", "in_process", "accepted", "rejected"];

const EMPTY: Record<string, { title: string; description?: string }> = {
  active: { title: "Nothing in progress", description: "Shortlist a role from Roles to start." },
  closed: { title: "Nothing closed yet" },
  all: { title: "Nothing in progress", description: "Shortlist a role from Roles to start." },
};

export default async function ApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string | string[]; page?: string; job?: string; company?: string; stage?: string; focus?: string }>;
}) {
  const user = await requireUser();
  const { filter: requestedFilter, page, job: requestedJob, company: requestedCompany, stage: requestedStage, focus: requestedFocus } = await searchParams;
  const filter = pipelineFilter(requestedFilter);
  const stage = ROLE_STAGES.find((value) => value === requestedStage && value !== "matched");
  const focus: PipelineFocus | undefined = requestedFocus === "due" || requestedFocus === "overdue" ? requestedFocus : undefined;
  const job = z.string().uuid().safeParse(requestedJob).success ? requestedJob : undefined;
  // The company page links here with its own id; an id the catalogue does not know is no filter.
  const company = z.string().uuid().safeParse(requestedCompany).success ? await pipelineCompany(requestedCompany!) : null;
  const now = new Date();
  // What the table holds, and what it owes this week. Both are scoped to the company a link names.
  const [result, cvWork] = await Promise.all([
    listPipeline(user.id, { filter, page, company: company ?? undefined, stage, focus, now }),
    getCvWorkStatus(user.id),
  ]);
  // The two lines a row can carry under its stage, worked out here so the table shows the words
  // the server computed rather than deriving them again against the viewer's clock. A next step
  // the person wrote answers "what do I owe" better than silence does, so it wins over the hint.
  const nextSteps = Object.fromEntries(
    result.rows.flatMap((row) => {
      const note = nextStep(row, now);
      return note ? [[row.key, note] as const] : [];
    }),
  );
  const staleHints = Object.fromEntries(
    result.rows.flatMap((row) => {
      const hint = nextSteps[row.key] ? null : applicationStaleHint(row, now);
      return hint ? [[row.key, hint] as const] : [];
    }),
  );
  const empty = focus ? { title: stage
      ? `No ${ROLE_STAGE_LABELS[stage].toLowerCase()} steps ${focus === "overdue" ? "overdue" : "due this week"}`
      : focus === "overdue" ? "No overdue steps" : "No steps due this week",
    description: "Add a dated next step to an application to see it here." }
    : stage ? { title: `No ${ROLE_STAGE_LABELS[stage].toLowerCase()} roles` } : EMPTY[filter]!;
  const linkTo = (values: Record<string, string>) => `/applications?${new URLSearchParams({ ...values, ...(company ? { company: company.id } : {}) })}`;
  const segmentHref = (segment: string) =>
    linkTo({ filter: segment });
  const emptyAction = focus || stage
    ? <Link prefetch={false} href={linkTo({ filter })} className={buttonLinkClass("secondary", "sm")}>View applications</Link>
    : company
      ? <Link prefetch={false} href={`/applications?filter=${filter}`} className={buttonLinkClass("secondary", "sm")}>Show all companies</Link>
      : filter === "closed"
        ? <Link prefetch={false} href={segmentHref("active")} className={buttonLinkClass("secondary", "sm")}>View active applications</Link>
        : <Link prefetch={false} href="/" className={buttonLinkClass("secondary", "sm")}>Find roles</Link>;
  const buildingRows = result.rows.filter((row) => row.cv?.status === "queued" || row.cv?.status === "generating");
  const building = buildingRows.length > 0;
  // A CV that is ready while its optional improvement still runs: the page keeps following it, so
  // an adopted revision replaces it in the row without a reload.
  const improvingRows = result.rows.filter((row) => row.cv?.status === "ready" && cvWork.improving.includes(row.cv.id));
  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title={company ? `Applications at ${company.name}` : "Applications"}
        description={company ? <Link prefetch={false} href={`/applications?filter=${filter}`} className="underline">Show all companies</Link> : undefined}
        actions={<Link prefetch={false} href="/applications/new" className={buttonLinkClass("secondary")}>Add a role</Link>}
      />
      <nav aria-label="Application filters" className="space-y-2 border-y border-line-muted py-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div role="group" aria-label="Progress" className="flex min-w-0 flex-wrap gap-2">
            {PIPELINE_FILTERS.map((segment) => (
              <Link prefetch={false} key={segment} href={segmentHref(segment)}
                aria-current={segment === filter && !focus && !stage ? "page" : undefined}
                className={buttonLinkClass(segment === filter && !focus && !stage ? "primary" : "secondary", "sm")}>
                {PIPELINE_FILTER_LABELS[segment]} <span className="ml-1 tabular-nums">{result.counts[segment]}</span>
              </Link>
            ))}
          </div>
          <div role="group" aria-label="Next steps" className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-14">
            <Link prefetch={false} href={linkTo({ filter: "active", focus: "due" })} aria-current={focus === "due" ? "page" : undefined}
              className={`inline-flex min-h-11 items-center underline underline-offset-2 ${focus === "due" ? "font-semibold" : ""}`}>
              Due this week <span className="ml-1 tabular-nums">{result.due}</span></Link>
            {result.overdue > 0 && <Link prefetch={false} href={linkTo({ filter: "active", focus: "overdue" })} aria-current={focus === "overdue" ? "page" : undefined}
              className={`inline-flex min-h-11 items-center underline underline-offset-2 ${focus === "overdue" ? "font-semibold" : ""}`}>
              Overdue <span className="ml-1 tabular-nums">{result.overdue}</span></Link>}
          </div>
        </div>
        <div role="group" aria-label="Application stages" className="flex flex-wrap gap-x-3 gap-y-1 text-13 text-muted">
          {STRIP_STAGES.map((value) => <Link key={value} prefetch={false} href={linkTo({ filter: "all", stage: value })}
            aria-current={value === stage ? "page" : undefined}
            className={`inline-flex min-h-11 items-center underline underline-offset-2 ${value === stage ? "font-semibold text-fg" : ""}`}>
            {ROLE_STAGE_LABELS[value]} <span className="ml-1 tabular-nums">{result.stages[value]}</span>
          </Link>)}
          {(focus || stage) && <Link prefetch={false} href={linkTo({ filter })} className="inline-flex min-h-11 items-center text-fg underline">Clear view</Link>}
        </div>
      </nav>
      {/* A CV on this page is still being written: the cells follow it without a reload. */}
      {(building || improvingRows.length > 0) && (
        <AutoRefresh scope="cv" initialVersion={cvWork.version} message={null} />
      )}
      <ApplicationsTable
        key={`${filter}:${stage ?? ""}:${focus ?? ""}:${result.page}:${company?.id ?? ""}`}
        rows={result.rows}
        openKey={job}
        nextSteps={nextSteps}
        staleHints={staleHints}
        emptyState={<EmptyState title={empty.title} description={empty.description} action={emptyAction} />}
      />
      {result.pageCount > 1 && (
        <Pagination
          page={result.page}
          total={result.total}
          path="/applications"
          params={{ filter, ...(stage ? { stage } : {}), ...(focus ? { focus } : {}), ...(company ? { company: company.id } : {}) }}
          label="Application pages"
        />
      )}
    </div>
  );
}
