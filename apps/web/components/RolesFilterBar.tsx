import { SORT_KEYS, STATUS_VALUES, type RolesFilters } from "@/lib/queries/jobs";
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
const chipClass = "flex items-center gap-2 border-2 border-line-muted px-2 py-1 text-13 text-muted has-[:checked]:border-line has-[:checked]:text-fg";

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
  const decided = decidedTab(view);
  const sortKeys = SORT_KEYS.filter(key => key !== "decided" || decided);
  return (
    <SearchForm action={path} className="mb-4 flex flex-wrap items-end gap-3 border-2 border-line-muted p-3">
      <input type="hidden" name="view" value={view} />
      {companyScoped && <input type="hidden" name="company" value={filters.company} />}
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
          Apply
        </button>
        <a href={`${path}?view=${view}`} className={buttonClass("ghost", "md", "no-underline")}>
          Reset
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
        <summary className="cursor-pointer text-12 text-muted">More filters</summary>
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
          <a href={exportHref} className="ml-auto self-center text-13 text-muted underline hover:text-fg" title="Every role in this view, with these filters and this sort">
            Export CSV
          </a>
        </div>
      </details>

    </SearchForm>
  );
}
