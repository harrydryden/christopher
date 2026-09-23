/** VERIFY: apply.workable.com/api/v3 is undocumented; www.workable.com/api/accounts is the legacy widget feed. */
import { IncompleteListingError, SourceFetchError, type Adapter, type FetchContext, type RawPosting, type SourceSpec } from "../types";
import { parseDate } from "../normalize";
import { fetchJson, htmlToText, joinLocation, pathSegments, rec, safeUrl, slugOk, str, verifyFromRead, INLINE_DESCRIPTIONS_FETCH, MAX_POSTINGS, type ListingRead } from "./common";

export function workableSpec(slug: string): SourceSpec {
  return { type: "workable", url: `https://apply.workable.com/${slug}/`, apiUrl: `https://apply.workable.com/api/v3/accounts/${slug}/jobs`, atsSlug: slug };
}

function slugFromUrl(url: string): string | null {
  const u = safeUrl(url);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  const segs = pathSegments(u);
  if (host === "apply.workable.com") {
    if (segs[0] === "api") {
      // /api/v3/accounts/{slug}/jobs
      const i = segs.indexOf("accounts");
      return i >= 0 && slugOk(segs[i + 1]) ? segs[i + 1]! : null;
    }
    return slugOk(segs[0]) ? segs[0] : null;
  }
  if (host === "www.workable.com" && segs[0] === "api" && segs[1] === "accounts") return slugOk(segs[2]) ? segs[2] : null;
  const m = host.match(/^([a-z0-9][a-z0-9-]*)\.workable\.com$/);
  if (m && m[1] !== "www" && m[1] !== "apply" && slugOk(m[1])) return m[1]!;
  return null;
}

interface WkJob {
  id?: string;
  shortcode?: string;
  title?: string;
  remote?: boolean;
  workplace?: string;
  location?: { country?: string; countryCode?: string; city?: string; region?: string };
  locations?: Array<{ country?: string; city?: string; region?: string }>;
  department?: string | string[];
  published?: string;
  published_on?: string;
  created_at?: string;
  type?: string;
  employment_type?: string;
  telecommuting?: boolean;
  url?: string;
  shortlink?: string;
  description?: string;
  country?: string;
  city?: string;
  state?: string;
  code?: string;
}

function locOf(l: WkJob["location"] | NonNullable<WkJob["locations"]>[number]): string | undefined {
  return joinLocation(l?.city, l?.region, l?.country);
}

function mapJob(j: WkJob, slug: string): RawPosting | null {
  const title = str(j.title);
  const shortcode = str(j.shortcode);
  const url = str(j.url) ?? str(j.shortlink) ?? (shortcode ? `https://apply.workable.com/${slug}/j/${shortcode}/` : undefined);
  if (!title || !url) return null;
  const primary = locOf(j.location) ?? joinLocation(j.city, j.state, j.country);
  const others = (j.locations ?? []).map(locOf).filter((s): s is string => !!s);
  const locations = [...new Set([...(primary ? [primary] : []), ...others])];
  const department = Array.isArray(j.department) ? j.department.filter(Boolean).join(" / ") : str(j.department);
  return {
    externalId: shortcode ?? str(j.id) ?? str(j.code),
    title,
    url,
    location: primary ?? (j.remote || j.telecommuting ? "Remote" : undefined),
    locations: locations.length > 1 ? locations : undefined,
    department: department || undefined,
    employmentType: str(j.type) ?? str(j.employment_type),
    remote: j.remote === true || j.telecommuting === true || j.workplace === "remote" ? true : undefined,
    postedAt: parseDate(j.published_on) ?? parseDate(j.published) ?? parseDate(j.created_at),
    descriptionText: htmlToText(j.description),
  };
}

/** Two hundred pages of the v3 feed; a board with more is read as incomplete, not as complete. */
const MAX_PAGES = 200;

/** The v3 feed does not have this board: the legacy widget feed is its listing instead. */
function boardAbsent(err: unknown): boolean {
  return err instanceof SourceFetchError && (err.status === 404 || err.kind === "parse");
}

/**
 * Up to `maxPages` pages of the v3 feed, or the legacy widget feed when v3 does not have the board.
 * The widget stands in only for a board v3 has nothing for: once a v3 page has been read, a later
 * page that fails leaves the listing incomplete, because the widget does not list the unread pages
 * the same way and a role it spells differently would register a miss.
 */
async function readListing(spec: SourceSpec, ctx: FetchContext, maxPages: number): Promise<ListingRead & { more?: string }> {
  const slug = spec.atsSlug;
  if (!slug) throw new Error("workable spec missing slug");
  const out: RawPosting[] = [];
  let token: string | undefined;
  let total: number | undefined;
  let page = 0;
  for (; page < maxPages; page++) {
    const body: Record<string, unknown> = { query: "", location: [], department: [], worktype: [], remote: [] };
    if (token) body.token = token;
    let data: { results?: WkJob[]; nextPage?: string; total?: number };
    try {
      ({ data } = await fetchJson<{ results?: WkJob[]; nextPage?: string; total?: number }>(ctx, `https://apply.workable.com/api/v3/accounts/${slug}/jobs`, {
        method: "POST",
        body,
      }));
    } catch (err) {
      if (page === 0 && boardAbsent(err)) break;
      if (page === 0) throw err;
      throw new IncompleteListingError(`Workable page ${page + 1} failed (${(err as Error).message}); this scan cannot close roles`, out.slice(0, MAX_POSTINGS));
    }
    if (typeof data.total === "number") total = data.total;
    const results = Array.isArray(data.results) ? data.results : [];
    for (const j of results) {
      const mapped = mapJob(j, slug);
      if (mapped) out.push(mapped);
    }
    token = str(data.nextPage);
    if (!token || results.length === 0 || out.length >= MAX_POSTINGS) break;
  }
  if (out.length > 0) {
    // A next-page token still in hand means the page budget ran out with more to read.
    const more = token ? `Workable listing stopped after ${Math.min(page + 1, maxPages)} pages with more pages to read; this scan cannot close roles` : undefined;
    return { postings: out.slice(0, MAX_POSTINGS), total, more };
  }
  const { data } = await fetchJson<unknown>(ctx, `https://www.workable.com/api/accounts/${slug}?details=true`, INLINE_DESCRIPTIONS_FETCH);
  const jobs = rec(data)?.jobs;
  const list = Array.isArray(jobs) ? (jobs as WkJob[]) : [];
  return { postings: list.map((j) => mapJob(j, slug)).filter((p): p is RawPosting => !!p).slice(0, MAX_POSTINGS) };
}

async function fetchPostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  const { postings, more } = await readListing(spec, ctx, MAX_PAGES);
  if (more) throw new IncompleteListingError(more, postings);
  return postings;
}

async function companyName(spec: SourceSpec, ctx: FetchContext): Promise<string | undefined> {
  const { data } = await fetchJson<unknown>(ctx, `https://www.workable.com/api/accounts/${spec.atsSlug}`);
  return str(rec(data)?.name);
}

export const workable: Adapter = {
  type: "workable",
  specFromUrl(url) {
    const slug = slugFromUrl(url);
    return slug ? workableSpec(slug) : null;
  },
  fetchPostings,
  verify: (spec, ctx) => verifyFromRead(() => readListing(spec, ctx, 1), () => companyName(spec, ctx))(),
};
