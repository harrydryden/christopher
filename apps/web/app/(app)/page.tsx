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
  fetchNearMissJobs,
  fetchRecentEventsFor,
  fetchTableJobs,
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
  const filters = parseRolesFilters(sp);
  const now = new Date();

  const settings = await getSettings();
  const [companyOptions, tableRowsRaw, nearMissRowsRaw] = await Promise.all([
    listCompanyOptions(),
    fetchTableJobs(),
    settings.nearMissEnabled ? fetchNearMissJobs(settings, 30) : Promise.resolve([]),
  ]);

  const allJobIds = [...tableRowsRaw, ...nearMissRowsRaw].map((r) => r.job.id);
  const eventsByJob = await fetchRecentEventsFor(allJobIds);
  const tableRows = attachEvents(tableRowsRaw, eventsByJob);
  const nearMissRows = attachEvents(nearMissRowsRaw, eventsByJob);

  const filteredSorted = sortRoleRows(applyRolesFilters(tableRows, filters, now), filters.sort, filters.dir, now);
  const { visible, hidden } = splitHidden(filteredSorted, settings.hideThreshold, filters.showHidden);

  const visibleVM = visible.map((r) => buildRoleRowVM(r, now));
  const hiddenVM = hidden.map((r) => buildRoleRowVM(r, now));
  const nearMissVM = sortRoleRows(nearMissRows, "firstSeen", "desc", now).map((r) => buildRoleRowVM(r, now));

  const exportHref = `/api/export.csv?${filtersToQueryString(filters)}`;

  return (
    <div>
      <PageHeader title="Roles" description="Keyword-matched roles across every company you track." />

      <RolesFilterBar filters={filters} companyOptions={companyOptions} hideThresholdSet={settings.hideThreshold !== null} exportHref={exportHref} />

      <RolesTable
        rows={visibleVM}
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

      {settings.nearMissEnabled && (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">Outside your keywords</h2>
          <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
            New roles that did not pass your keyword or location filter, but scored {settings.nearMissMinScore}+ on fit. Deciding on
            these feeds your preference profile just like any other role.
          </p>
          <RolesTable
            rows={nearMissVM}
            emptyState={<EmptyState title="Nothing outside your keywords right now" description="High-scoring roles that miss your keyword filter will show up here." />}
          />
        </section>
      )}

      {settings.hideThreshold !== null && (
        <details className="mt-8 rounded-lg border border-slate-200 dark:border-slate-800">
          <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
            Hidden by your preferences ({hiddenVM.length})
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
