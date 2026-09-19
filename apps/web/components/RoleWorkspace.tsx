import Link from "next/link";
import { ROLE_STATUS_LABELS, ROLE_TABS, type RoleStatus } from "@christopher/core";
import { Card } from "./Card";
import { EmptyState } from "./EmptyState";
import { RolesTable } from "./RolesTable";
import { RolesFilterBar } from "./RolesFilterBar";
import { attachEvents, buildRoleRowVM, fetchRecentEventsFor, fetchRolePage, fetchRoleCounts, filtersToQueryString, parseRolesFilters, resolveRoleView, type RawSearchParams } from "@/lib/queries/jobs";
import { listCompanyOptions } from "@/lib/queries/companies";

export async function RoleWorkspace({ userId, searchParams, companyId }: { userId: string; searchParams: RawSearchParams; companyId?: string }) {
  const sp = searchParams;
  const scoped = companyId ? { company: companyId } : {};
  // Counts first, then the page: a link that names no view opens on Matched unless this scope has
  // no matched roles, so the counts are an input to every read below them.
  const counts = await fetchRoleCounts(userId, parseRolesFilters({ ...sp, ...scoped }).company || undefined);
  const view = resolveRoleView(sp, counts);
  const dismissed = view === "user-dismissed";
  const filters = parseRolesFilters({ ...sp, view, ...scoped });
  const archivedFilters = parseRolesFilters({ ...sp, view: "archived", ...scoped });
  const path = companyId ? `/companies/${companyId}` : "/";
  const [result, archivedResult, options] = await Promise.all([
    fetchRolePage(userId, filters, false, null, Number(sp.page)),
    // The archived section is only rendered under Dismissed, so nothing else pays for the read.
    dismissed ? fetchRolePage(userId, archivedFilters, true, null, Number(sp.archivedPage)) : null,
    companyId ? Promise.resolve([]) : listCompanyOptions(userId),
  ]);
  const pageRows = [...result.visible, ...(archivedResult?.visible ?? [])];
  const events = await fetchRecentEventsFor(userId, pageRows.map(row => row.job.id));
  const rows = attachEvents(result.visible, events).map(row => buildRoleRowVM(row, new Date(), userId));
  const archivedRows = attachEvents(archivedResult?.visible ?? [], events).map(row => buildRoleRowVM(row, new Date(), userId));
  const query = `${filtersToQueryString(filters)}&view=${view}`;
  const href = (page: number) => `${path}?${query}${archivedResult && archivedResult.page > 1 ? `&archivedPage=${archivedResult.page}` : ""}&page=${page}#roles`;
  const archivedHref = (page: number) => `${path}?${query}${result.page > 1 ? `&page=${result.page}` : ""}&archivedPage=${page}#archived`;
  const viewHref = (status: RoleStatus) => `${path}?view=${status}${!companyId && filters.company ? `&company=${filters.company}` : ""}#roles`;
  return <section id="roles">
    <nav aria-label="Role status" className="mb-4 flex flex-wrap gap-2">
      {ROLE_TABS.map(status => <Link key={status} href={viewHref(status)} aria-current={status === view ? "page" : undefined}
        className={`ds-pixel border-2 px-3 py-2 text-11 no-underline ${status === view ? "border-fg bg-fg text-bg" : "border-transparent text-muted hover:bg-sunken hover:text-fg"}`}>
        {ROLE_STATUS_LABELS[status]}{" "}<span className="ml-1 tabular-nums">{counts[status]}</span>
      </Link>)}
    </nav>
    <RolesFilterBar key={query} filters={filters} companyOptions={options}
      exportHref={`/api/export.csv?${query}`} path={path} view={view} companyScoped={!!companyId} />
    <p className="mb-3 text-12 text-muted">Showing {result.total} of {counts[view]} {ROLE_STATUS_LABELS[view].toLowerCase()} {counts[view] === 1 ? "role" : "roles"}</p>
    <RolesTable key={`${query}:${result.page}`} rows={rows} keyboard hideCompany={!!companyId}
      emptyState={<EmptyState title={counts[view] ? "No roles match these filters" : view === "auto-matched" ? "No roles awaiting review" : `No ${ROLE_STATUS_LABELS[view].toLowerCase()} roles`}
        description={counts[view] ? "Clear the filters to see the other roles in this view." : undefined} />} />
    {result.pageCount > 1 && <nav aria-label="Role pages" className="my-4 flex items-center gap-4 text-13">
      {result.page > 1 && <Link className="underline" href={href(result.page - 1)}>Previous</Link>}
      <span>Page {result.page} of {result.pageCount}</span>
      {result.page < result.pageCount && <Link className="underline" href={href(result.page + 1)}>Next</Link>}
    </nav>}
    {archivedResult && <div id="archived" className="mt-6">
      <Card title="Archived" actions={<span className="text-12 text-muted tabular-nums">{counts.archived}</span>}>
        <p className="mb-3 text-12 text-muted">Showing {archivedResult.total} of {counts.archived} archived {counts.archived === 1 ? "role" : "roles"}</p>
        <RolesTable key={`${query}:archived:${archivedResult.page}`} rows={archivedRows} archived hideCompany={!!companyId}
          emptyState={<EmptyState title="No archived roles" description="Archived roles are ones you put away or that stopped matching your filters." />} />
        {archivedResult.pageCount > 1 && <nav aria-label="Archived role pages" className="mt-4 flex items-center gap-4 text-13">
          {archivedResult.page > 1 && <Link className="underline" href={archivedHref(archivedResult.page - 1)}>Previous</Link>}
          <span>Page {archivedResult.page} of {archivedResult.pageCount}</span>
          {archivedResult.page < archivedResult.pageCount && <Link className="underline" href={archivedHref(archivedResult.page + 1)}>Next</Link>}
        </nav>}
      </Card>
    </div>}
  </section>;
}
