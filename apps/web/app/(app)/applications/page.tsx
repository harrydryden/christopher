import { Fragment } from "react";
import Link from "next/link";
import { z } from "zod";
import { ROLE_STAGES, ROLE_STAGE_DESCRIPTIONS, ROLE_STAGE_LABELS, type RoleStage } from "@ava/core";
import { ApplicationsTable } from "@/components/ApplicationsTable";
import { AutoRefresh } from "@/components/AutoRefresh";
import { getCvWorkStatus } from "@/lib/work-status";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Pagination } from "@/components/Pagination";
import { dueLine, nextStep } from "@/lib/application-dates";
import { needsEmailConfirmation, requireUser } from "@/lib/auth";
import { cvQuoteLine } from "@/lib/cv-quote";
import {
  applicationStaleHint,
  listPipeline,
  pipelineCompany,
  pipelineCvQuotes,
  pipelineDueCount,
  pipelineFilter,
  PIPELINE_FILTERS,
  PIPELINE_FILTER_LABELS,
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
  searchParams: Promise<{ filter?: string | string[]; page?: string; job?: string; company?: string }>;
}) {
  const user = await requireUser();
  const { filter: requestedFilter, page, job: requestedJob, company: requestedCompany } = await searchParams;
  const filter = pipelineFilter(requestedFilter);
  const job = z.string().uuid().safeParse(requestedJob).success ? requestedJob : undefined;
  // The company page links here with its own id; an id the catalogue does not know is no filter.
  const company = z.string().uuid().safeParse(requestedCompany).success ? await pipelineCompany(requestedCompany!) : null;
  const now = new Date();
  // What the table holds, and what it owes this week. Both are scoped to the company a link names.
  const [result, due, cvWork] = await Promise.all([
    listPipeline(user.id, { filter, page, company: company ?? undefined }),
    pipelineDueCount(user.id, { company: company ?? undefined, now }),
    getCvWorkStatus(user.id),
  ]);
  // What a build would cost, for the rows on this page, so the price is beside the button rather
  // than in the build log of a CV that has already been paid for. The figures are turned into
  // their sentences here: the table is a client component and the pricing is a database read.
  // An account that has still to confirm its address cannot build anything, so nothing is priced.
  const unverified = needsEmailConfirmation(user);
  const quotes = unverified
    ? {}
    : Object.fromEntries(
        Object.entries(await pipelineCvQuotes(user.id, result.rows)).map(([jobId, quote]) => [
          jobId,
          { line: cvQuoteLine(quote), refusal: quote.refusal },
        ]),
      );
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
  const dueNote = dueLine(due);
  const empty = EMPTY[filter]!;
  const segmentHref = (segment: string) =>
    `/applications?${new URLSearchParams({ filter: segment, ...(company ? { company: company.id } : {}) })}`;
  const building = result.rows.some((row) => row.cv?.status === "queued" || row.cv?.status === "generating");
  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title={company ? `Applications at ${company.name}` : "Applications"}
        description={
          company ? (
            <>
              Every role you are pursuing at {company.name}.{" "}
              <Link prefetch={false} href={`/applications?filter=${filter}`} className="underline">Show all companies</Link>
            </>
          ) : (
            "Every role you are pursuing, from shortlist to outcome."
          )
        }
      />
      {/* Where everything stands, in one line, before the segments narrow it. A stage nothing has
          reached is shown at zero rather than left out: the shape of the pipeline is the point. */}
      <p className="text-13">
        <span className="sr-only">Roles by stage: </span>
        {STRIP_STAGES.map((stage, index) => (
          <Fragment key={stage}>
            {index > 0 && <span className="text-muted" aria-hidden="true"> · </span>}
            <span className={result.stages[stage] ? "text-fg" : "text-muted"}>
              {ROLE_STAGE_LABELS[stage]} <span className="tabular-nums">{result.stages[stage]}</span>
            </span>
          </Fragment>
        ))}
      </p>
      {/* A hint, like the stale one: the product sends nothing, it only reads differently here. */}
      {dueNote && <p className="text-13 text-muted">{dueNote}</p>}
      {/* The same shape as the roles tabs: links, so the segment is in the URL and shareable. */}
      <nav aria-label="Application progress" className="mb-4 flex flex-wrap gap-2">
        {PIPELINE_FILTERS.map((segment) => (
          <Link prefetch={false}
            key={segment}
            href={segmentHref(segment)}
            aria-current={segment === filter ? "page" : undefined}
            className={`ds-pixel border-2 px-3 py-2 text-11 no-underline ${segment === filter ? "border-accent bg-accent text-accent-fg" : "border-transparent text-muted hover:bg-sunken hover:text-fg"}`}
          >
            {PIPELINE_FILTER_LABELS[segment]} <span className="ml-1 tabular-nums">{result.counts[segment]}</span>
          </Link>
        ))}
      </nav>
      {/* A CV on this page is still being written: the cells follow it without a reload. */}
      {building && <AutoRefresh scope="cv" initialVersion={cvWork.version} message="A CV for one of these roles is being built. This page updates itself." />}
      <ApplicationsTable
        key={`${filter}:${result.page}:${company?.id ?? ""}`}
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
          params={{ filter, ...(company ? { company: company.id } : {}) }}
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
