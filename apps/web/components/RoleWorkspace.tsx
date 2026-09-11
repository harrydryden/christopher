import Link from "next/link";
import { ROLE_STATUSES, ROLE_STATUS_LABELS, type RoleStatus } from "@christopher/core";
import { EmptyState } from "./EmptyState";
import { RolesTable } from "./RolesTable";
import { RolesFilterBar } from "./RolesFilterBar";
import { attachEvents, buildRoleRowVM, fetchRecentEventsFor, fetchRolePage, fetchRoleCounts, filtersToQueryString, parseRolesFilters, type RawSearchParams } from "@/lib/queries/jobs";
import { listCompanyOptions } from "@/lib/queries/companies";

export async function RoleWorkspace({ searchParams, companyId }: { searchParams: RawSearchParams; companyId?: string }) {
  const sp = searchParams;
  const legacy = sp.archive === "1" ? "archived" : sp.decision === "apply" ? "user-shortlisted" : sp.decision === "skip" ? "user-dismissed" : "auto-matched";
  const view = (ROLE_STATUSES as readonly unknown[]).includes(sp.view) ? sp.view as RoleStatus : legacy;
  const archived = view === "archived";
  const filters = parseRolesFilters({ ...sp, view, ...(companyId ? { company: companyId } : {}) });
  const path = companyId ? `/companies/${companyId}` : "/";
  const [result, counts, options] = await Promise.all([
    fetchRolePage(filters, archived, null, Number(sp.page)),
    fetchRoleCounts(companyId || filters.company || undefined),
    companyId ? Promise.resolve([]) : listCompanyOptions(),
  ]);
  const events = await fetchRecentEventsFor(result.visible.map(row => row.job.id));
  const rows = attachEvents(result.visible, events).map(row => buildRoleRowVM(row));
  const query = `${filtersToQueryString(filters)}&view=${view}`;
  const href = (page: number) => `${path}?${query}&page=${page}#roles`;
  const viewHref = (status: RoleStatus) => `${path}?view=${status}${!companyId && filters.company ? `&company=${filters.company}` : ""}#roles`;
  return <section id="roles">
    <nav aria-label="Role status" className="mb-4 flex flex-wrap gap-2 text-sm">
      {ROLE_STATUSES.map(status => <Link key={status} href={viewHref(status)} aria-current={status === view ? "page" : undefined}
        className={`rounded-md px-3 py-2 ${status === view ? "bg-slate-200 font-medium" : "text-slate-500 hover:bg-slate-100"}`}>
        {ROLE_STATUS_LABELS[status]}{" "}<span className="ml-1 tabular-nums">{counts[status]}</span>
      </Link>)}
    </nav>
    <RolesFilterBar key={query} filters={filters} companyOptions={options}
      exportHref={`/api/export.csv?${query}`} path={path} view={view} companyScoped={!!companyId} />
    <p className="mb-3 text-xs text-slate-500">Showing {result.total} of {counts[view]} {ROLE_STATUS_LABELS[view].toLowerCase()} {counts[view] === 1 ? "role" : "roles"} · {view === "auto-matched" ? "Awaiting your review" : view === "archived" ? "History retained; restore to reconsider" : "Your decisions are preserved when matching criteria change"}</p>
    <RolesTable key={`${query}:${result.page}`} rows={rows} archived={archived} keyboard hideCompany={!!companyId}
      emptyState={<EmptyState title={counts[view] ? "No roles match these filters" : view === "auto-matched" ? "No roles awaiting review" : `No ${ROLE_STATUS_LABELS[view].toLowerCase()} roles`}
        description={counts[view] ? "Clear the filters to see the other roles in this view." : "New vacancies that do not match your criteria are not stored."} />} />
    {result.pageCount > 1 && <nav aria-label="Role pages" className="my-4 flex items-center gap-4 text-sm">
      {result.page > 1 && <Link className="underline" href={href(result.page - 1)}>Previous</Link>}
      <span>Page {result.page} of {result.pageCount}</span>
      {result.page < result.pageCount && <Link className="underline" href={href(result.page + 1)}>Next</Link>}
    </nav>}
  </section>;
}
