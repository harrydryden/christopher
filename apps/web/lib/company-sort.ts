/**
 * The Tracked companies table sorts on its column heads through the URL (`?sort=open&dir=desc`).
 * Pure, so the whitelist is tested without a database: anything not listed here falls back to the
 * default, and only these keys ever reach `listCompanies`' order-by map.
 */
export const COMPANY_SORT_KEYS = ["company", "source", "status", "open", "review", "shortlisted"] as const;
export type CompanySortKey = (typeof COMPANY_SORT_KEYS)[number];
export type CompanySortDir = "asc" | "desc";
export interface CompanySort { sort: CompanySortKey; dir: CompanySortDir }

/**
 * The direction a column opens in: names A–Z, counts largest first. Status sorts by the last scan
 * (the line under the badge), newest first.
 */
export const DEFAULT_COMPANY_SORT_DIR: Record<CompanySortKey, CompanySortDir> = {
  company: "asc",
  source: "asc",
  status: "desc",
  open: "desc",
  review: "desc",
  shortlisted: "desc",
};

export const DEFAULT_COMPANY_SORT: CompanySort = { sort: "company", dir: "asc" };

export function parseCompanySort(sortRaw?: string | null, dirRaw?: string | null): CompanySort {
  const sort = (COMPANY_SORT_KEYS as readonly string[]).includes(sortRaw ?? "") ? (sortRaw as CompanySortKey) : DEFAULT_COMPANY_SORT.sort;
  const dir: CompanySortDir = dirRaw === "asc" || dirRaw === "desc" ? dirRaw : DEFAULT_COMPANY_SORT_DIR[sort];
  return { sort, dir };
}

/** What a head links to: the same column turns round, another column opens in its own direction. */
export function nextCompanySort(current: CompanySort, key: CompanySortKey): CompanySort {
  if (current.sort === key) return { sort: key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { sort: key, dir: DEFAULT_COMPANY_SORT_DIR[key] };
}

/** The URL params a sort needs; the default says nothing, so `/companies` stays `/companies`. */
export function companySortParams(sort: CompanySort): Record<string, string> {
  if (sort.sort === DEFAULT_COMPANY_SORT.sort && sort.dir === DEFAULT_COMPANY_SORT.dir) return {};
  return { sort: sort.sort, dir: sort.dir };
}
