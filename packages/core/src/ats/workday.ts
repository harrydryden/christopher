/** VERIFY: the /wday/cxs endpoint is undocumented but stable across tenants; shapes confirmed against fixtures. */
import { SourceFetchError, type FetchContext, type RawPosting, type SourceSpec } from "../types";
import { parseRelativePosted } from "../normalize";
import { completeListing, feedAdapter, fetchJson, pathSegments, readOffsetPages, safeUrl, str, MAX_POSTINGS, type PagedRead } from "./common";

const HOST_RE = /^([a-z0-9][a-z0-9-]*)\.(wd\d+)\.myworkdayjobs\.com$/;
const LOCALE_RE = /^[a-z]{2}(-[A-Za-z]{2})?$/;

export function workdaySpec(host: string, tenant: string, site: string): SourceSpec {
  return {
    type: "workday",
    url: `https://${host}/${site}`,
    apiUrl: `https://${host}/wday/cxs/${tenant}/${site}/jobs`,
    atsSlug: tenant,
    atsSite: `${host}|${site}`,
  };
}

function parts(spec: SourceSpec): { host: string; tenant: string; site: string } | null {
  const tenant = spec.atsSlug;
  const [host, site] = (spec.atsSite ?? "").split("|");
  if (!tenant || !host || !site) return null;
  return { host, tenant, site };
}

function fromUrl(url: string): SourceSpec | null {
  const u = safeUrl(url);
  if (!u) return null;
  const m = u.hostname.toLowerCase().match(HOST_RE);
  if (!m) return null;
  const host = u.hostname.toLowerCase();
  const tenant = m[1]!;
  const segs = pathSegments(u);
  // /wday/cxs/{tenant}/{site}/jobs
  if (segs[0] === "wday" && segs[1] === "cxs" && segs[3]) return workdaySpec(host, segs[2] ?? tenant, segs[3]);
  // /{locale?}/{site}...
  const first = segs[0];
  const site = first && LOCALE_RE.test(first) ? segs[1] : first;
  if (!site) return null;
  return workdaySpec(host, tenant, site);
}

interface WdPosting {
  title?: string;
  externalPath?: string;
  locationsText?: string;
  remoteType?: string;
  postedOn?: string;
  bulletFields?: string[];
}

const LOCATION_COUNT_RE = /^([1-9]\d*) Locations$/i;
const MAX_DETAIL_LOCATIONS = 1000;
const MAX_LOCATION_LENGTH = 200;

function locationCount(label: string | undefined): number | null {
  const match = str(label)?.match(LOCATION_COUNT_RE);
  if (!match) return null;
  const count = Number(match[1]);
  return Number.isSafeInteger(count) ? count : Number.POSITIVE_INFINITY;
}

function mapPosting(p: WdPosting, host: string, site: string, now: Date): RawPosting | null {
  const title = str(p.title);
  const path = str(p.externalPath);
  if (!title || !path) return null;
  const locationsText = str(p.locationsText);
  const counted = locationCount(locationsText) !== null;
  const split = counted ? [] : locationsText?.split(/\s*(?:;|\band\b|\|)\s*/).map((s) => s.trim()).filter(Boolean) ?? [];
  return {
    externalId: str(p.bulletFields?.[0]) ?? path,
    title,
    url: `https://${host}/${site}${path}`,
    location: counted ? undefined : locationsText,
    locations: split.length > 1 ? split : undefined,
    locationLabel: counted ? locationsText : undefined,
    locationResolution: counted ? "pending" : undefined,
    remote: /^remote$/i.test(str(p.remoteType) ?? "") || (locationsText ? /remote/i.test(locationsText) : false) || undefined,
    postedAt: p.postedOn ? parseRelativePosted(p.postedOn, now) : undefined,
  };
}

/** Resolve one counted Workday listing through its source's own public detail JSON. */
export async function fetchWorkdayLocations(
  spec: SourceSpec,
  posting: Pick<RawPosting, "url" | "locationLabel">,
  ctx: FetchContext,
): Promise<{ location: string; locations: string[] }> {
  const source = spec.type === "workday" ? parts(spec) : null;
  const expected = locationCount(posting.locationLabel);
  const url = safeUrl(posting.url);
  const prefix = source ? `/${source.site}/job/` : "";
  if (!source || !HOST_RE.test(source.host) || HOST_RE.exec(source.host)?.[1] !== source.tenant
      || !/^[A-Za-z0-9_-]+$/.test(source.site) || expected === null || expected > MAX_DETAIL_LOCATIONS
      || !url || url.protocol !== "https:" || url.username || url.password || url.port
      || url.hostname.toLowerCase() !== source.host || !url.pathname.startsWith(prefix)
      || url.pathname.length <= prefix.length || url.search || url.hash || posting.url.includes("\\")
      || /%(?:2f|5c|2e)/i.test(url.pathname) || url.pathname.includes("//")) {
    throw new SourceFetchError("Workday detail URL or counted location label is outside the source", "parse");
  }
  const detailUrl = `https://${source.host}/wday/cxs/${source.tenant}/${source.site}${url.pathname.slice(source.site.length + 1)}`;
  const { data, res } = await fetchJson<unknown>(ctx, detailUrl, { maxBodyBytes: 1_000_000 });
  if (res.url !== detailUrl) throw new SourceFetchError("Workday detail redirected outside its source", "parse");
  const info = data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>).jobPostingInfo : null;
  if (!info || typeof info !== "object" || Array.isArray(info))
    throw new SourceFetchError("Workday detail lacks jobPostingInfo", "parse");
  const fields = info as Record<string, unknown>;
  const additional = fields.additionalLocations;
  if (!Array.isArray(additional) || additional.length > MAX_DETAIL_LOCATIONS - 1)
    throw new SourceFetchError("Workday detail has invalid additional locations", "parse");
  const values = [fields.location, ...additional];
  if (values.length !== expected || values.some((value) => typeof value !== "string" || !value.trim()
      || value.trim().length > MAX_LOCATION_LENGTH || locationCount(value) !== null))
    throw new SourceFetchError("Workday detail location count or strings are incomplete", "parse");
  const locations = values.map((value) => (value as string).trim());
  if (new Set(locations.map((value) => value.toLocaleLowerCase())).size !== expected)
    throw new SourceFetchError("Workday detail repeats a counted location", "parse");
  return { location: locations[0]!, locations };
}

const PAGE_SIZE = 20;
/** Every page a listing may take: the posting cap at Workday's twenty roles a page. */
const MAX_PAGES = MAX_POSTINGS / PAGE_SIZE;

/** Up to `maxPages` pages of the listing. */
async function readPages(spec: SourceSpec, ctx: FetchContext, maxPages: number): Promise<PagedRead> {
  const p = parts(spec);
  if (!p) throw new Error("workday spec missing host/tenant/site");
  const now = ctx.now?.() ?? new Date();
  return readOffsetPages({
    pageSize: PAGE_SIZE,
    maxPages,
    // Some tenants report `total` on the first page only and send 0 on every page after it, so the
    // count is taken once: trusting the later zero made page two look like the end of the board.
    totalPolicy: "first",
    fetchPage: async (offset) => {
      const { data } = await fetchJson<{ total?: number; jobPostings?: WdPosting[] }>(ctx, `https://${p.host}/wday/cxs/${p.tenant}/${p.site}/jobs`, {
        method: "POST",
        body: { appliedFacets: {}, limit: PAGE_SIZE, offset, searchText: "" },
      });
      return { items: Array.isArray(data.jobPostings) ? data.jobPostings : [], total: data.total };
    },
    map: (wp) => mapPosting(wp, p.host, p.site, now),
  });
}

async function fetchPostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  return completeListing("Workday", await readPages(spec, ctx, MAX_PAGES));
}

export const workday = feedAdapter({ type: "workday", fromUrl, read: fetchPostings, verifyRead: (spec, ctx) => readPages(spec, ctx, 1) });
