/** VERIFY: the /wday/cxs endpoint is undocumented but stable across tenants; shapes confirmed against fixtures. */
import { IncompleteListingError, type Adapter, type FetchContext, type RawPosting, type SourceSpec } from "../types";
import { parseRelativePosted } from "../normalize";
import { fetchJson, pathSegments, safeUrl, str, verifyFromFetch, MAX_POSTINGS } from "./common";

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
  postedOn?: string;
  bulletFields?: string[];
}

function mapPosting(p: WdPosting, host: string, site: string, now: Date): RawPosting | null {
  const title = str(p.title);
  const path = str(p.externalPath);
  if (!title || !path) return null;
  const locationsText = str(p.locationsText);
  const split = locationsText?.split(/\s*(?:;|\band\b|\|)\s*/).map((s) => s.trim()).filter(Boolean) ?? [];
  return {
    externalId: str(p.bulletFields?.[0]) ?? path,
    title,
    url: `https://${host}/${site}${path}`,
    location: locationsText,
    locations: split.length > 1 ? split : undefined,
    remote: locationsText ? /remote/i.test(locationsText) || undefined : undefined,
    postedAt: p.postedOn ? parseRelativePosted(p.postedOn, now) : undefined,
  };
}

async function fetchPostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  const p = parts(spec);
  if (!p) throw new Error("workday spec missing host/tenant/site");
  const now = ctx.now?.() ?? new Date();
  const out: RawPosting[] = [];
  const limit = 20;
  // Some tenants report `total` on the first page only and send 0 on every page after it, so the
  // count is taken once: trusting the later zero made page two look like the end of the board.
  let total: number | undefined;
  let more = false;
  for (let offset = 0; offset < MAX_POSTINGS; offset += limit) {
    const { data } = await fetchJson<{ total?: number; jobPostings?: WdPosting[] }>(ctx, `https://${p.host}/wday/cxs/${p.tenant}/${p.site}/jobs`, {
      method: "POST",
      body: { appliedFacets: {}, limit, offset, searchText: "" },
    });
    const postings = Array.isArray(data.jobPostings) ? data.jobPostings : [];
    for (const wp of postings) {
      const mapped = mapPosting(wp, p.host, p.site, now);
      if (mapped) out.push(mapped);
    }
    if (total === undefined && typeof data.total === "number" && data.total > 0) total = data.total;
    if (postings.length === 0) { more = false; break; }
    // With no usable total, a full page is the only evidence left that another page exists.
    more = total === undefined ? postings.length === limit : offset + limit < total;
    if (!more) break;
  }
  const result = out.slice(0, MAX_POSTINGS);
  if (more) throw new IncompleteListingError(`Workday listing stopped at ${result.length} roles with more pages to read; this scan cannot close roles`, result);
  return result;
}

export const workday: Adapter = {
  type: "workday",
  specFromUrl: fromUrl,
  fetchPostings,
  verify: (spec, ctx) => verifyFromFetch(() => fetchPostings(spec, ctx))(),
};
