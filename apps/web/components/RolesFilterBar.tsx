import { SORT_KEYS, STATUS_VALUES, type RolesFilters } from "@/lib/queries/jobs";

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
  const inputClass =
    "rounded-md border border-slate-300 bg-white px-2 py-1 text-sm outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500";
  return (
    <form action={path} method="get" className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3">
      <input type="hidden" name="view" value={view} />
      {companyScoped && <input type="hidden" name="company" value={filters.company} />}
      {!companyScoped && <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
        Company
        <select name="company" defaultValue={filters.company} className={inputClass}>
          <option value="">All companies</option>
          {companyOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>}
      <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
        Search title
        <input type="text" name="q" defaultValue={filters.q} placeholder="Search…" className={`w-40 ${inputClass}`} />
      </label>
      <div className="ml-auto flex items-end gap-2 pb-0.5">
        <a href={exportHref} className="rounded-md px-2 py-1 text-sm text-slate-600 underline hover:text-slate-900">
          Export CSV
        </a>
        <button type="submit" className="rounded-md bg-[var(--app-navy)] px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700">
          Apply filters
        </button>
        <a href={`${path}?view=${view}`} className="rounded-md px-2 py-1.5 text-sm text-slate-500 hover:text-slate-800">
          Reset
        </a>
      </div>
      <details className="w-full">
        <summary className="cursor-pointer text-xs text-slate-500">More filters and sorting</summary>
        <div className="mt-3 flex flex-wrap items-end gap-3">
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium text-slate-500">Vacancy availability</legend>
        <div className="flex gap-2">{STATUS_VALUES.map(status => <label key={status} className="flex items-center gap-1 text-sm">
          <input type="checkbox" name="status" value={status} defaultChecked={filters.status.includes(status)} />{STATUS_LABELS[status]}
        </label>)}</div>
      </fieldset>
      <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
        Location contains
        <input type="text" name="location" defaultValue={filters.location} placeholder="e.g. London" className={`w-32 ${inputClass}`} />
      </label>

      <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
        Min fit
        <input type="number" name="minFit" min={0} max={100} defaultValue={filters.minFit ?? ""} placeholder="0" className={`w-20 ${inputClass}`} />
      </label>



      <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
        Sort by
        <select name="sort" defaultValue={filters.sort} className={inputClass}>
          {SORT_KEYS.map((s) => (
            <option key={s} value={s}>
              {SORT_LABELS[s]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
        Direction
        <select name="dir" defaultValue={filters.dir} className={inputClass}>
          <option value="asc">Ascending</option>
          <option value="desc">Descending</option>
        </select>
      </label>

        </div>
      </details>

    </form>
  );
}
