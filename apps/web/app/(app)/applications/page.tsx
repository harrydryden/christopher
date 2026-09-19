import Link from "next/link";
import { z } from "zod";
import { ROLE_STAGES, ROLE_STAGE_DESCRIPTIONS, ROLE_STAGE_LABELS } from "@christopher/core";
import { ApplicationsTable } from "@/components/ApplicationsTable";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Pagination } from "@/components/Pagination";
import { requireUser } from "@/lib/auth";
import { listPipeline, pipelineFilter, PIPELINE_FILTERS, PIPELINE_FILTER_LABELS } from "@/lib/queries/applications";

export const dynamic = "force-dynamic";

const EMPTY: Record<string, { title: string; description?: string }> = {
  active: { title: "Nothing in progress", description: "Shortlist a role from Roles to start." },
  closed: { title: "Nothing closed yet" },
  all: { title: "Nothing in progress", description: "Shortlist a role from Roles to start." },
};

export default async function ApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string | string[]; page?: string; job?: string }>;
}) {
  const user = await requireUser();
  const { filter: requestedFilter, page, job: requestedJob } = await searchParams;
  const filter = pipelineFilter(requestedFilter);
  const job = z.string().uuid().safeParse(requestedJob).success ? requestedJob : undefined;
  const result = await listPipeline(user.id, { filter, page });
  const empty = EMPTY[filter]!;
  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader title="Applications" description="Every role you are pursuing, from shortlist to outcome." />
      {/* The same shape as the roles tabs: links, so the segment is in the URL and shareable. */}
      <nav aria-label="Application progress" className="mb-4 flex flex-wrap gap-2">
        {PIPELINE_FILTERS.map((segment) => (
          <Link
            key={segment}
            href={`/applications?filter=${segment}`}
            aria-current={segment === filter ? "page" : undefined}
            className={`ds-pixel border-2 px-3 py-2 text-11 no-underline ${segment === filter ? "border-fg bg-fg text-bg" : "border-transparent text-muted hover:bg-sunken hover:text-fg"}`}
          >
            {PIPELINE_FILTER_LABELS[segment]} <span className="ml-1 tabular-nums">{result.counts[segment]}</span>
          </Link>
        ))}
      </nav>
      <ApplicationsTable
        key={`${filter}:${result.page}`}
        rows={result.rows}
        openKey={job}
        emptyState={<EmptyState title={empty.title} description={empty.description} />}
      />
      {result.pageCount > 1 && (
        <Pagination page={result.page} total={result.total} path="/applications" params={{ filter }} label="Application pages" />
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
