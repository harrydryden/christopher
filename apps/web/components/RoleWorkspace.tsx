import Link from "next/link";
import { ROLE_STATUS_LABELS, ROLE_TABS, type RoleStatus } from "@ava/core";
import { Card } from "./Card";
import { EmptyState } from "./EmptyState";
import { buttonLinkClass } from "./Button";
import { RolesTable } from "./RolesTable";
import { RoleRefusalNotices } from "./RoleRefusalNotices";
import { RolesFilterBar } from "./RolesFilterBar";
import { appliedRoleCount, attachEvents, buildRoleRowVM, DEFAULT_SORT_DIR, fetchRecentEventsFor, fetchRolePage, fetchRoleCounts, filtersToQueryString, parseRolesFilters, resolveRoleView, roleTabFor, type RawSearchParams, type RolesFilters, type SortKey } from "@/lib/queries/jobs";
import { listCompanyOptions } from "@/lib/queries/companies";
import { pipelineCompany, pipelineStageCounts } from "@/lib/queries/applications";

/** The columns that sort (R-7.1), and the key each one sorts by. */
const SORTABLE_COLUMNS = ["company", "title", "location", "fit"] as const;

/**
 * One href per sortable column head, carrying the filters in hand: sorting a column never drops a
 * search, a company or an availability choice. Clicking the column already sorted turns it round.
 */
function sortLinksFor(path: string, view: RoleStatus, filters: RolesFilters): Partial<Record<SortKey, string>> {
  const links: Partial<Record<SortKey, string>> = {};
  for (const key of SORTABLE_COLUMNS) {
    const dir = filters.sort === key ? (filters.dir === "asc" ? "desc" : "asc") : DEFAULT_SORT_DIR[key];
    links[key] = `${path}?${filtersToQueryString({ ...filters, sort: key, dir })}&view=${view}#roles`;
  }
  return links;
}

export async function RoleWorkspace({ userId, searchParams, companyId }: { userId: string; searchParams: RawSearchParams; companyId?: string }) {
  const sp = searchParams;
  const scoped = companyId ? { company: companyId } : {};
  const countsPending = fetchRoleCounts(userId, parseRolesFilters({ ...sp, ...scoped }).company || undefined);
  const pageFor = (view: RoleStatus) => fetchRolePage(userId, parseRolesFilters({ ...sp, view, ...scoped }), false, null, Number(sp.page));
  // A link that names no view (the landing URL) opens on Matched unless this scope has no matched
  // roles. Matched is what it nearly always is, so its page is read beside the counts rather than
  // after them, and read again as Shortlisted only when the counts say Matched is empty. A link that
  // names its view (every tab, sort and page link does) reads the counts beside that view's page.
  const named = roleTabFor(sp);
  const likely = named ? null : pageFor("auto-matched");
  // Discarded when the guess was wrong; its failure then belongs to nobody.
  likely?.catch(() => undefined);
  const view = named ?? resolveRoleView(sp, await countsPending);
  const dismissed = view === "user-dismissed";
  const filters = parseRolesFilters({ ...sp, view, ...scoped });
  const archivedFilters = parseRolesFilters({ ...sp, view: "archived", ...scoped });
  const path = companyId ? `/companies/${companyId}` : "/";
  const [counts, result, archivedResult, options, stageCounts] = await Promise.all([
    countsPending,
    likely && view === "auto-matched" ? likely : pageFor(view),
    // The archived section is only rendered under Dismissed, so nothing else pays for the read.
    dismissed ? fetchRolePage(userId, archivedFilters, true, null, Number(sp.archivedPage)) : null,
    companyId ? Promise.resolve([]) : listCompanyOptions(userId),
    // How far the shortlist has got, from the one reading of the lifecycle the Applications page
    // uses, scoped to this company when the strip is a company's own.
    companyId
      ? pipelineCompany(companyId).then(company => pipelineStageCounts(userId, company ? { company } : {}))
      : pipelineStageCounts(userId),
  ]);
  // "Shortlisted 12 · 3 applied": of the roles you chose to pursue, the ones actually sent.
  const applied = appliedRoleCount(stageCounts);
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
      {ROLE_TABS.map(status => <Link prefetch={false} key={status} href={viewHref(status)} aria-current={status === view ? "page" : undefined}
        className={`ds-pixel border-2 px-3 py-2 text-11 no-underline ${status === view ? "border-accent bg-accent text-accent-fg" : "border-transparent text-muted hover:bg-sunken hover:text-fg"}`}>
        {ROLE_STATUS_LABELS[status]}{" "}<span className="ml-1 tabular-nums">{counts[status]}</span>
        {status === "user-shortlisted" && counts[status] > 0 && applied > 0 && <span className="ml-1 tabular-nums">· {applied} applied</span>}
      </Link>)}
    </nav>
    <RolesFilterBar key={query} filters={filters} companyOptions={options}
      exportHref={`/api/export.csv?${query}`} path={path} view={view} companyScoped={!!companyId} />
    {result.total !== counts[view] && <p className="mb-3 text-12 text-muted">Showing {result.total} of {counts[view]}</p>}
    {/* Outside the keyed tables, so a refusal that lands after paging or filtering still shows. */}
    <RoleRefusalNotices />
    <RolesTable key={`${query}:${result.page}`} rows={rows} keyboard hideCompany={!!companyId}
      sortLinks={sortLinksFor(path, view, filters)} sort={filters.sort} dir={filters.dir}
      emptyState={<EmptyState title={counts[view] ? "No roles match these filters" : view === "auto-matched" ? "No roles awaiting review" : `No ${ROLE_STATUS_LABELS[view].toLowerCase()} roles`}
        action={counts[view] ? <Link prefetch={false} href={`${path}?view=${view}#roles`} className={buttonLinkClass("secondary")}>Clear filters</Link> : undefined} />} />
    {result.pageCount > 1 && <nav aria-label="Role pages" className="my-4 flex items-center gap-4 text-13">
      {result.page > 1 && <Link prefetch={false} className="underline" href={href(result.page - 1)}>Previous</Link>}
      <span>Page {result.page} of {result.pageCount}</span>
      {result.page < result.pageCount && <Link prefetch={false} className="underline" href={href(result.page + 1)}>Next</Link>}
    </nav>}
    {/* The stage legend lives on Applications, where stages are moved; a row's stage badge carries its meaning as a tooltip. */}
    {archivedResult && <div id="archived" className="mt-6">
      <Card title="Archived" actions={<span className="text-12 text-muted tabular-nums">{counts.archived}</span>}>
        {archivedResult.total !== counts.archived && <p className="mb-3 text-12 text-muted">Showing {archivedResult.total} of {counts.archived}</p>}
        <RolesTable key={`${query}:archived:${archivedResult.page}`} rows={archivedRows} archived hideCompany={!!companyId}
          emptyState={<EmptyState title="No archived roles" description="Roles you archived or that stopped matching." />} />
        {archivedResult.pageCount > 1 && <nav aria-label="Archived role pages" className="mt-4 flex items-center gap-4 text-13">
          {archivedResult.page > 1 && <Link prefetch={false} className="underline" href={archivedHref(archivedResult.page - 1)}>Previous</Link>}
          <span>Page {archivedResult.page} of {archivedResult.pageCount}</span>
          {archivedResult.page < archivedResult.pageCount && <Link prefetch={false} className="underline" href={archivedHref(archivedResult.page + 1)}>Next</Link>}
        </nav>}
      </Card>
    </div>}
  </section>;
}
