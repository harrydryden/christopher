import { AutoRefresh } from "@/components/AutoRefresh";
import { getCompanyWorkStatus } from "@/lib/work-status";
import Link from "next/link";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { RolesFilterBar } from "@/components/RolesFilterBar";
import { RolesTable } from "@/components/RolesTable";
import { listCompanyOptions } from "@/lib/queries/companies";
import {
  attachEvents,
  buildRoleRowVM,
  fetchRecentEventsFor,
  fetchRolePage,
  filtersToQueryString,
  parseRolesFilters,
  type RawSearchParams,
} from "@/lib/queries/jobs";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function RolesPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const sp = await searchParams;
  const archived = sp.archive === "1";
  const filters = parseRolesFilters(archived ? { ...sp, decision: sp.decision ?? "all", ...(!sp.status ? { status: ["new", "active", "closed"], closed: "1" } : {}) } : sp);
  const now = new Date();

  const [settings, companyOptions, work] = await Promise.all([getSettings(), listCompanyOptions(), getCompanyWorkStatus()]);
  const result = await fetchRolePage(filters, archived, settings.hideThreshold, Number(sp.page), now);
  const { page, pageCount } = result;
  const events = await fetchRecentEventsFor(result.visible.map(row => row.job.id));
  const visibleVM = attachEvents(result.visible, events).map(row => buildRoleRowVM(row, now));
  const pageHref = (n: number) => `/?${filtersToQueryString(filters)}&page=${n}${archived ? "&archive=1" : ""}`;

  const exportHref = `/api/export.csv?${filtersToQueryString(filters)}${archived ? "&archive=1" : ""}`;

  return (
    <div>
      {work.active && <AutoRefresh message="Scans, discovery or filter updates are pending. Results update as work completes." />}
      <PageHeader title={archived ? "Archived roles" : filters.decision === "skip" ? "Skipped roles" : filters.decision === "apply" ? "Shortlist" : "Roles"} description="Role and seniority matches across your tracked companies." />
      <nav aria-label="Role views" className="mb-4 flex flex-wrap gap-2 text-sm">
        {[
          { href: "/", label: "Inbox", active: !archived && filters.decision === "inbox" },
          { href: "/?decision=apply", label: "Shortlist", active: !archived && filters.decision === "apply" },
          { href: "/?decision=skip", label: "Skipped", active: !archived && filters.decision === "skip" },
          { href: "/?archive=1", label: "Archive", active: archived },
        ].map(view => <Link key={view.href} href={view.href} aria-current={view.active ? "page" : undefined}
          className={`rounded-md px-3 py-2 ${view.active ? "bg-slate-200 font-medium" : "text-slate-500 hover:bg-slate-100"}`}>{view.label}</Link>)}
        <Link href="/settings" className="ml-auto px-3 py-2 text-slate-500 underline">Edit keyword filters</Link>
      </nav>

      <RolesFilterBar key={`${archived}:${filtersToQueryString(filters)}`} archived={archived} filters={filters} companyOptions={companyOptions} hideThresholdSet={settings.hideThreshold !== null} exportHref={exportHref} />

      <RolesTable
        key={`${archived}:${filtersToQueryString(filters)}:${page}`}
        rows={visibleVM}
        archived={archived}
        keyboard
        emptyState={
          <EmptyState
            title="No roles match your filters"
            description={
              <>
                Try widening your filters, or{" "}
                <Link href="/companies" className="underline">
                  add a company
                </Link>{" "}
                to start tracking its roles.
              </>
            }
          />
        }
      />

      <nav aria-label="Role pages" className="my-4 flex items-center gap-4 text-sm">
        {page > 1 && <Link className="underline" href={pageHref(page - 1)}>Previous</Link>}
        <span>Page {page} of {pageCount} · {result.total} roles</span>
        {page < pageCount && <Link className="underline" href={pageHref(page + 1)}>Next</Link>}
      </nav>
      {settings.hideThreshold !== null && !filters.showHidden && result.hiddenTotal > 0 && (
        <p className="mt-4 text-sm text-slate-500">{result.hiddenTotal} roles hidden by your fit preferences. <Link className="underline" href={`/?${filtersToQueryString({ ...filters, showHidden: true })}${archived ? "&archive=1" : ""}`}>Show hidden roles</Link></p>
      )}
    </div>
  );
}
