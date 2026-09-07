import Link from "next/link";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { RolesFilterBar } from "@/components/RolesFilterBar";
import { RolesTable } from "@/components/RolesTable";
import { listCompanyOptions } from "@/lib/queries/companies";
import {
  applyRolesFilters,
  attachEvents,
  buildRoleRowVM,
  fetchRecentEventsFor,
  fetchTableJobs,
  fetchRoleDetails,
  filtersToQueryString,
  parseRolesFilters,
  sortRoleRows,
  splitHidden,
  type RawSearchParams,
} from "@/lib/queries/jobs";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function RolesPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const sp = await searchParams;
  const archived = sp.archive === "1";
  const filters = parseRolesFilters(archived ? { ...sp, decision: sp.decision ?? "all", ...(!sp.status ? { status: ["new", "active", "closed"], closed: "1" } : {}) } : sp);
  const now = new Date();

  const [settings, companyOptions, tableRowsRaw] = await Promise.all([
    getSettings(),
    listCompanyOptions(),
    fetchTableJobs(archived, true),

  ]);

  const filteredSorted = sortRoleRows(applyRolesFilters(tableRowsRaw, filters, now), filters.sort, filters.dir, now);
  const { visible, hidden } = splitHidden(filteredSorted, settings.hideThreshold, filters.showHidden);
  const pageSize = 50;
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const requestedPage = Number(sp.page);
  const page = Math.min(pageCount, Math.max(1, Number.isSafeInteger(requestedPage) ? requestedPage : 1));
  const pageRows = visible.slice((page - 1) * pageSize, page * pageSize);
  const hiddenRows = hidden.slice(0, pageSize);
  const ids = [...pageRows, ...hiddenRows].map(row => row.job.id);
  const [details, events] = await Promise.all([fetchRoleDetails(ids), fetchRecentEventsFor(ids)]);
  const byId = new Map(attachEvents(details, events).map(row => [row.job.id, row]));
  const visibleVM = pageRows.map(row => buildRoleRowVM(byId.get(row.job.id) ?? row, now));
  const hiddenVM = hiddenRows.map(row => buildRoleRowVM(byId.get(row.job.id) ?? row, now));
  const pageHref = (n: number) => `/?${filtersToQueryString(filters)}&page=${n}${archived ? "&archive=1" : ""}`;

  const exportHref = `/api/export.csv?${filtersToQueryString(filters)}${archived ? "&archive=1" : ""}`;

  return (
    <div>
      <PageHeader title={archived ? "Archived roles" : filters.decision === "skip" ? "Skipped roles" : filters.decision === "apply" ? "Shortlist" : "Roles"} description="Role and seniority matches across your tracked companies." />
      <nav aria-label="Role views" className="mb-4 flex flex-wrap gap-2 text-sm">
        {[
          { href: "/", label: "Inbox", active: !archived && filters.decision === "inbox" },
          { href: "/?decision=apply", label: "Shortlist", active: !archived && filters.decision === "apply" },
          { href: "/?decision=skip", label: "Skipped", active: !archived && filters.decision === "skip" },
          { href: "/?archive=1", label: "Archive", active: archived },
        ].map(view => <Link key={view.href} href={view.href} aria-current={view.active ? "page" : undefined}
          className={`rounded-md px-3 py-2 ${view.active ? "bg-slate-200 font-medium dark:bg-slate-800" : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-900"}`}>{view.label}</Link>)}
        <Link href="/settings" className="ml-auto px-3 py-2 text-slate-500 underline">Edit keyword filters</Link>
      </nav>

      <RolesFilterBar key={`${archived}:${filtersToQueryString(filters)}`} archived={archived} filters={filters} companyOptions={companyOptions} hideThresholdSet={settings.hideThreshold !== null} exportHref={exportHref} />

      <RolesTable
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
        <span>Page {page} of {pageCount} · {visible.length} roles</span>
        {page < pageCount && <Link className="underline" href={pageHref(page + 1)}>Next</Link>}
      </nav>
      {settings.hideThreshold !== null && (
        <details className="mt-8 rounded-lg border border-slate-200 dark:border-slate-800">
          <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
            Hidden by your preferences ({hidden.length}; showing up to 50)
          </summary>
          <div className="border-t border-slate-200 p-4 dark:border-slate-800">
            <RolesTable
              rows={hiddenVM}
              emptyState={<EmptyState title="Nothing hidden right now" description={`Open roles scoring under ${settings.hideThreshold} are collapsed here.`} />}
            />
          </div>
        </details>
      )}
    </div>
  );
}
