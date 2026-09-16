import { SORT_KEYS, STATUS_VALUES, type RolesFilters } from "@/lib/queries/jobs";
import { buttonClass } from "@/components/Button";
import { inputClass, labelClass, selectClass } from "@/components/Field";

const STATUS_LABELS: Record<(typeof STATUS_VALUES)[number], string> = { new: "Newly opened", active: "Open", closed: "Closed" };

const SORT_LABELS: Record<(typeof SORT_KEYS)[number], string> = {
  status: "Vacancy age",
  fit: "Fit score",
  company: "Company",
  liveFor: "Live for",
  firstSeen: "First seen",
  title: "Title",
  location: "Location",
};

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
  return (
    <form action={path} method="get" className="mb-4 flex flex-wrap items-end gap-3 border-2 border-line-muted p-3">
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
        <span className={labelClass}>Search title</span>
        <input type="text" name="q" defaultValue={filters.q} placeholder="Search…" className={`w-50 ${inputClass}`} />
      </label>
      <div className="ml-auto flex flex-wrap items-center gap-3">
        <a href={exportHref} className="text-13 text-muted underline hover:text-fg">
          Export CSV
        </a>
        <button type="submit" className={buttonClass("primary")}>
          Apply filters
        </button>
        <a href={`${path}?view=${view}`} className={buttonClass("ghost", "md", "no-underline")}>
          Reset
        </a>
      </div>
      <details className="w-full">
        <summary className="cursor-pointer text-12 text-muted">More filters and sorting</summary>
        <div className="mt-3 flex flex-wrap items-end gap-3">
      <fieldset className="flex flex-col gap-1.5">
        <legend className={labelClass}>Vacancy availability</legend>
        <div className="flex gap-3">{STATUS_VALUES.map(status => <label key={status} className="flex items-center gap-2 text-14">
          <input type="checkbox" name="status" value={status} defaultChecked={filters.status.includes(status)} className="h-4 w-4" />{STATUS_LABELS[status]}
        </label>)}</div>
      </fieldset>
      <label className="flex flex-col gap-1.5">
        <span className={labelClass}>Location contains</span>
        <input type="text" name="location" defaultValue={filters.location} placeholder="e.g. London" className={`w-36 ${inputClass}`} />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className={labelClass}>Min fit</span>
        <input type="number" name="minFit" min={0} max={100} defaultValue={filters.minFit ?? ""} placeholder="0" className={`w-24 ${inputClass}`} />
      </label>



      <label className="flex flex-col gap-1.5">
        <span className={labelClass}>Sort by</span>
        <select name="sort" defaultValue={filters.sort} className={selectClass}>
          {SORT_KEYS.map((s) => (
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

        </div>
      </details>

    </form>
  );
}
