import { Fragment } from "react";
import Link from "next/link";
import { z } from "zod";
import { ROLE_STAGES, ROLE_STAGE_DESCRIPTIONS, ROLE_STAGE_LABELS, type RoleStage } from "@ava/core";
import { ApplicationsTable, type PipelineCvQuotes } from "@/components/ApplicationsTable";
import { AutoRefresh } from "@/components/AutoRefresh";
import { getCvWorkStatus } from "@/lib/work-status";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Pagination } from "@/components/Pagination";
import { nextStep } from "@/lib/application-dates";
import { needsEmailConfirmation, requireUser } from "@/lib/auth";
import { cvQuoteLine } from "@/lib/cv-quote";
import {
  applicationStaleHint,
  listPipeline,
  pipelineCompany,
  pipelineCvQuotes,
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

/** Each row's price as the sentence the CV section shows, and the refusal when the budget will not admit it. */
async function pricedQuotes(userId: string, rows: Parameters<typeof pipelineCvQuotes>[1]): Promise<PipelineCvQuotes> {
  // The price is advice beside the button; the build action applies the budget itself. A pricing
  // read that fails leaves the buttons unpriced rather than failing an open row after the fact.
  const quotes = await pipelineCvQuotes(userId, rows).catch((error: unknown) => {
    console.error(JSON.stringify({ event: "cv_quotes_failed", message: error instanceof Error ? error.message : String(error) }));
    return {} as Awaited<ReturnType<typeof pipelineCvQuotes>>;
  });
  return Object.fromEntries(Object.entries(quotes).map(([jobId, quote]) => [jobId, { line: cvQuoteLine(quote), refusal: quote.refusal }]));
}

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
  // What a build would cost, for the rows on this page, so the price is beside the button rather
  // than in the build log of a CV that has already been paid for. The figures are turned into
  // their sentences here: the table is a client component and the pricing is a database read.
  // The read is not awaited: the table renders at once and the prices stream in behind it, into
  // the CV section of an open row, which is the only place they are shown. An account that has
  // still to confirm its address cannot build anything, so nothing is priced.
  const unverified = needsEmailConfirmation(user);
  const quotes = unverified ? {} : pricedQuotes(user.id, result.rows);
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
  const empty = focus ? { title: focus === "overdue" ? "No overdue steps" : "No steps due this week", description: "Add a dated next step to an application to see it here." }
    : stage ? { title: `No ${ROLE_STAGE_LABELS[stage].toLowerCase()} roles` } : EMPTY[filter]!;
  const linkTo = (values: Record<string, string>) => `/applications?${new URLSearchParams({ ...values, ...(company ? { company: company.id } : {}) })}`;
  const segmentHref = (segment: string) =>
    linkTo({ filter: segment });
  const buildingRows = result.rows.filter((row) => row.cv?.status === "queued" || row.cv?.status === "generating");
  const building = buildingRows.length > 0;
  // A CV that is ready while its optional improvement still runs: the page keeps following it, so
  // an adopted revision replaces it in the row without a reload.
  const improvingRows = result.rows.filter((row) => row.cv?.status === "ready" && cvWork.improving.includes(row.cv.id));
  const improvingMessage = improvingRows.length === 1
    ? `The CV for ${improvingRows[0]!.companyName} · ${improvingRows[0]!.jobTitle} is ready; a stronger revision is being tried, and this page updates itself.`
    : `${improvingRows.length} ready CVs are being improved; this page updates itself.`;
  // What the one build in flight is doing, above the table; several are counted instead.
  const only = buildingRows.length === 1 ? buildingRows[0]! : null;
  const buildingMessage = only
    ? `The CV for ${only.companyName} · ${only.jobTitle} is ${only.cv!.status === "queued" ? "queued" : `being built${only.cv!.progress ? `: ${only.cv!.progress}` : ""}`}; this page updates itself.`
    : `${buildingRows.length} CVs are being built; this page updates itself.`;
  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title={company ? `Applications at ${company.name}` : "Applications"}
        description={company ? <Link prefetch={false} href={`/applications?filter=${filter}`} className="underline">Show all companies</Link> : undefined}
      />
      {/* Where everything stands, in one line, before the segments narrow it. A stage nothing has
          reached is shown at zero rather than left out: the shape of the pipeline is the point. */}
      <p className="text-13">
        <span className="sr-only">Roles by stage: </span>
        {STRIP_STAGES.map((stage, index) => (
          <Fragment key={stage}>
            {index > 0 && <span className="text-muted" aria-hidden="true"> · </span>}
            <Link prefetch={false} href={linkTo({ filter: "all", stage })} aria-current={stage === requestedStage && !focus ? "page" : undefined}
              className={`inline-flex min-h-11 items-center underline-offset-2 hover:underline ${result.stages[stage] ? "text-fg" : "text-muted"}`}>
              {ROLE_STAGE_LABELS[stage]} <span className="tabular-nums">{result.stages[stage]}</span>
            </Link>
          </Fragment>
        ))}
      </p>
      {/* A hint, like the stale one: the product sends nothing, it only reads differently here. */}
      <nav aria-label="Next steps" className="flex flex-wrap gap-3 text-13">
        <Link prefetch={false} href={linkTo({ filter: "all", focus: "due" })} aria-current={focus === "due" ? "page" : undefined} className="inline-flex min-h-11 items-center underline">Due this week ({result.due})</Link>
        <Link prefetch={false} href={linkTo({ filter: "all", focus: "overdue" })} aria-current={focus === "overdue" ? "page" : undefined} className="inline-flex min-h-11 items-center underline">Overdue ({result.overdue})</Link>
        {(focus || stage) && <Link prefetch={false} href={linkTo({ filter })} className="inline-flex min-h-11 items-center underline">Clear view</Link>}
      </nav>
      {/* The same shape as the roles tabs: links, so the segment is in the URL and shareable. */}
      <nav aria-label="Application progress" className="mb-4 flex flex-wrap gap-2">
        {PIPELINE_FILTERS.map((segment) => (
          <Link prefetch={false}
            key={segment}
            href={segmentHref(segment)}
            aria-current={segment === filter && !focus && !stage ? "page" : undefined}
            className={`ds-pixel inline-flex min-h-11 items-center border-2 px-3 py-2 text-11 no-underline ${segment === filter && !focus && !stage ? "border-accent bg-accent text-accent-fg" : "border-transparent text-muted hover:bg-sunken hover:text-fg"}`}
          >
            {PIPELINE_FILTER_LABELS[segment]} <span className="ml-1 tabular-nums">{result.counts[segment]}</span>
          </Link>
        ))}
      </nav>
      {/* A CV on this page is still being written: the cells follow it without a reload. */}
      {(building || improvingRows.length > 0) && (
        <AutoRefresh scope="cv" initialVersion={cvWork.version} message={building ? buildingMessage : improvingMessage} />
      )}
      <ApplicationsTable
        key={`${filter}:${stage ?? ""}:${focus ?? ""}:${result.page}:${company?.id ?? ""}`}
        rows={result.rows}
        openKey={job}
        quotes={quotes}
        nextSteps={nextSteps}
        staleHints={staleHints}
        unverified={unverified}
        emptyState={<EmptyState title={empty.title} description={empty.description} />}
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
      <details className="text-13 text-muted">
        <summary className="cursor-pointer">What the stages mean</summary>
        <dl className="mt-2 space-y-1">
          {ROLE_STAGES.map((stage) => (
            <div key={stage} className="flex flex-wrap gap-2">
              <dt className="ds-pixel text-10 text-fg">{ROLE_STAGE_LABELS[stage]}</dt>
              <dd>{ROLE_STAGE_DESCRIPTIONS[stage]}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}
