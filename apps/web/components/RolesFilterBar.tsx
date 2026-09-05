import { DECISION_VALUES, SORT_KEYS, STATUS_VALUES, type RolesFilters } from "@/lib/queries/jobs";

const STATUS_LABELS: Record<(typeof STATUS_VALUES)[number], string> = { new: "New", active: "Active", closed: "Closed" };
const DECISION_LABELS: Record<(typeof DECISION_VALUES)[number], string> = { all: "All", undecided: "Undecided", apply: "Applied", skip: "Skipped" };
const SORT_LABELS: Record<(typeof SORT_KEYS)[number], string> = {
  status: "Status (default)",
  fit: "Fit score",
  company: "Company",
  liveFor: "Live for",
  firstSeen: "First seen",
  title: "Title",
  location: "Location",
};

export function RolesFilterBar({
  filters,
  companyOptions,
  hideThresholdSet,
  exportHref,
}: {
  filters: RolesFilters;
  companyOptions: Array<{ id: string; name: string }>;
  hideThresholdSet: boolean;
  exportHref: string;
}) {
  const inputClass =
    "rounded-md border border-slate-300 bg-white px-2 py-1 text-sm outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-950";
  return (
    <form method="get" className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium text-slate-500">Status</legend>
        <div className="flex gap-2">
          {STATUS_VALUES.map((s) => (
            <label key={s} className="flex items-center gap-1 text-sm">
              <input type="checkbox" name="status" value={s} defaultChecked={filters.status.includes(s)} />
              {STATUS_LABELS[s]}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
        Company
        <select name="company" defaultValue={filters.company} className={inputClass}>
          <option value="">All companies</option>
          {companyOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
        Decision
        <select name="decision" defaultValue={filters.decision} className={inputClass}>
          {DECISION_VALUES.map((d) => (
            <option key={d} value={d}>
              {DECISION_LABELS[d]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
        Location contains
        <input type="text" name="location" defaultValue={filters.location} placeholder="e.g. London" className={`w-32 ${inputClass}`} />
      </label>

      <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
        Min fit
        <input type="number" name="minFit" min={0} max={100} defaultValue={filters.minFit ?? ""} placeholder="0" className={`w-20 ${inputClass}`} />
      </label>

      <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
        Search title
        <input type="text" name="q" defaultValue={filters.q} placeholder="Search…" className={`w-40 ${inputClass}`} />
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

      <label className="flex items-center gap-1 pb-1.5 text-sm">
        <input type="checkbox" name="closed" value="1" defaultChecked={filters.closed} />
        Show closed
      </label>

      {hideThresholdSet && (
        <label className="flex items-center gap-1 pb-1.5 text-sm">
          <input type="checkbox" name="showHidden" value="1" defaultChecked={filters.showHidden} />
          Show hidden
        </label>
      )}

      <div className="ml-auto flex items-end gap-2 pb-0.5">
        <a href={exportHref} className="rounded-md px-2 py-1 text-sm text-slate-600 underline hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100">
          Export CSV
        </a>
        <button type="submit" className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900">
          Apply filters
        </button>
        <a href="/" className="rounded-md px-2 py-1.5 text-sm text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100">
          Reset
        </a>
      </div>
    </form>
  );
}
