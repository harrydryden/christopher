export function pageNumber(raw?: string): number {
  const n = Number(raw ?? 1);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, 100000) : 1;
}

export function Pagination({ page, total, size = 50, path, params = {}, pageParam = "page", label = "Pagination" }: {
  page: number; total: number; size?: number; path: string; params?: Record<string, string>; pageParam?: string; label?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  const href = (n: number) => `${path}?${new URLSearchParams({ ...params, [pageParam]: String(n) })}`;
  return <nav aria-label={label} className="my-4 flex flex-wrap items-center justify-between gap-3 text-sm">
    <span>{total.toLocaleString("en-GB")} {total === 1 ? "result" : "results"} · Page {page} of {pages}</span>
    <div className="flex gap-4">
      {page > 1 && <a className="inline-flex min-h-11 items-center underline" href={href(page - 1)}>Previous</a>}
      {page < pages && <a className="inline-flex min-h-11 items-center underline" href={href(page + 1)}>Next</a>}
    </div>
  </nav>;
}
