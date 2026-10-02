"use client";

import { useState } from "react";
import { SORT_KEYS, STATUS_VALUES } from "@/lib/roles-filter-options";
import type { RolesFilters } from "@/lib/queries/jobs";
import { buttonClass } from "@/components/Button";
import { inputClass, labelClass, selectClass } from "@/components/Field";
import { SearchForm, SearchPending } from "@/components/SearchForm";

const STATUS_LABELS: Record<(typeof STATUS_VALUES)[number], string> = { new: "Newly opened", active: "Open", closed: "Closed" };

const SORT_LABELS: Record<(typeof SORT_KEYS)[number], string> = {
  status: "Vacancy age",
  fit: "Fit score",
  company: "Company",
  liveFor: "Live for",
  firstSeen: "First seen",
  title: "Title",
  location: "Location",
  decided: "Decided",
};

/** A checkbox that reads as a chip: the control stays a control, the border says it is on. */
const chipClass = "flex min-h-11 items-center gap-2 border-2 border-line-muted px-2 py-1 text-13 text-muted has-[:checked]:border-line has-[:checked]:text-fg";

/** Sorting and filtering by decision date only answer a question on the two decided tabs. */
function decidedTab(view: string): boolean {
  return view === "user-shortlisted" || view === "user-dismissed";
}

export function RolesFilterBar({
  path = "/", view = "auto-matched", companyScoped = false,
  filters,
  companyOptions,
  exportHref,
}: {
  path?: string; view?: string; companyScoped?: boolean;
  filters: RolesFilters;
  companyOptions: Array<{ id: string; name: string }>;
  exportHref: string;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const decided = decidedTab(view);
  const sortKeys = SORT_KEYS.filter(key => key !== "decided" || decided);
  const active: string[] = [];
  if (filters.company && !companyScoped) active.push(`Company: ${companyOptions.find(c => c.id === filters.company)?.name ?? "Selected company"}`);
  if (filters.q) active.push(`Title: ${filters.q}`);
  if (filters.status.length !== STATUS_VALUES.length) active.push(filters.status.length
    ? `Availability: ${filters.status.map(status => STATUS_LABELS[status]).join(", ")}`
    : "Availability: none");
  if (filters.location) active.push(`Location: ${filters.location}`);
  if (filters.minFit !== null) active.push(`Min fit: ${filters.minFit}`);
  if (decided && filters.sinceDays !== null) active.push(`Decided: last ${filters.sinceDays} days`);
  if (filters.sort !== "status" || filters.dir !== "asc") active.push(`Sort: ${SORT_LABELS[filters.sort]}, ${filters.dir === "asc" ? "ascending" : "descending"}`);
  const clearHref = `${path}?view=${encodeURIComponent(view)}${companyScoped && filters.company ? `&company=${encodeURIComponent(filters.company)}` : ""}#roles`;
  return (
    <SearchForm action={`${path}#roles`} className="mb-4 border-2 border-line-muted p-2 md:p-3">
      <input type="hidden" name="view" value={view} />
      {companyScoped && <input type="hidden" name="company" value={filters.company} />}
      <div className="flex min-h-11 w-full items-center justify-between gap-3">
        <div className="min-w-0 truncate text-13 text-muted" aria-label="Active filters">
          {active.length ? <><span className="font-semibold text-fg">Active filters:</span>{" "}{active.join(" · ")}</> : "All roles in this view"}
        </div>
        <button type="button" aria-expanded={mobileOpen} aria-controls="role-filter-fields"
          onClick={() => setMobileOpen(open => !open)}
          className="inline-flex min-h-11 shrink-0 items-center px-2 text-13 font-semibold underline md:hidden">
          {mobileOpen ? "Hide filters" : "Filters"}
        </button>
      </div>
      <div id="role-filter-fields" className={`${mobileOpen ? "flex" : "hidden"} w-full flex-wrap items-end gap-3 border-t border-line-faint pt-3 md:flex`}>
      {!companyScoped && <label className="flex flex-col gap-1.5">
        <span className={labelClass}>Company</span>
        <select name="company" defaultValue={filters.company} className={`w-50 ${selectClass}`}>
          <option value="">All companies</option>
          {companyOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>}
      <label className="flex flex-col gap-1.5">
        <span className={labelClass}>Title</span>
        <input type="text" name="q" defaultValue={filters.q} placeholder="Search…" className={`w-50 ${inputClass}`} />
      </label>
      <div className="ml-auto flex flex-wrap items-center gap-3">
        <SearchPending />
        <button type="submit" className={buttonClass("primary")}>
          Update results
        </button>
        <a href={clearHref} className={buttonClass("ghost", "md", "no-underline")}>
          Clear filters
        </a>
      </div>
      {/* Availability is the filter people reach for, so it sits in the open as chips. */}
      <fieldset className="flex w-full flex-wrap items-center gap-2">
        <legend className="sr-only">Availability</legend>
        <span className={labelClass}>Availability</span>
        {STATUS_VALUES.map(status => <label key={status} className={chipClass}>
          <input type="checkbox" name="status" value={status} defaultChecked={filters.status.includes(status)} className="h-4 w-4" />{STATUS_LABELS[status]}
        </label>)}
        {decided && <label className={chipClass} title="Only roles you decided on in the last seven days">
          <input type="checkbox" name="since" value="7d" defaultChecked={filters.sinceDays !== null} className="h-4 w-4" />This week
        </label>}
      </fieldset>
      <details className="w-full">
        <summary className="inline-flex min-h-11 cursor-pointer items-center text-13 text-muted">More filters</summary>
        <div className="mt-3 flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1.5">
        <span className={labelClass}>Location</span>
        <input type="text" name="location" defaultValue={filters.location} placeholder="e.g. London" className={`w-36 ${inputClass}`} />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className={labelClass}>Min fit</span>
        <input type="number" name="minFit" min={0} max={100} defaultValue={filters.minFit ?? ""} placeholder="0" className={`w-24 ${inputClass}`} />
      </label>



      <label className="flex flex-col gap-1.5">
        <span className={labelClass}>Sort by</span>
        <select name="sort" defaultValue={filters.sort} className={selectClass}>
          {sortKeys.map((s) => (
            <option key={s} value={s}>
              {SORT_LABELS[s]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className={labelClass}>Direction</span>
        <select name="dir" defaultValue={filters.dir} className={selectClass}>
          <option value="asc">Ascending</option>
          <option value="desc">Descending</option>
        </select>
      </label>

          {/* Rarely needed, so it sits with the other occasional controls. */}
          <a href={exportHref} className="ml-auto inline-flex min-h-11 items-center self-center text-13 text-muted underline hover:text-fg" title="Every role in this view, with these filters and this sort">
            Export CSV
          </a>
        </div>
      </details>
      </div>
    </SearchForm>
  );
}
