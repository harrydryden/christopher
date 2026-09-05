/** VERIFY: apply.workable.com/api/v3 is undocumented; www.workable.com/api/accounts is the legacy widget feed. */
import type { Adapter, FetchContext, RawPosting, SourceSpec } from "../types";
import { parseDate } from "../normalize";
import { fetchJson, htmlToText, joinLocation, pathSegments, rec, safeUrl, slugOk, str, verifyFromFetch, MAX_POSTINGS } from "./common";

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

async function fetchPostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  const slug = spec.atsSlug;
  if (!slug) throw new Error("workable spec missing slug");
  try {
    const out: RawPosting[] = [];
    let token: string | undefined;
    for (let page = 0; page < 10; page++) {
      const body: Record<string, unknown> = { query: "", location: [], department: [], worktype: [], remote: [] };
      if (token) body.token = token;
      const { data } = await fetchJson<{ results?: WkJob[]; nextPage?: string; total?: number }>(ctx, `https://apply.workable.com/api/v3/accounts/${slug}/jobs`, {
        method: "POST",
        body,
      });
      const results = Array.isArray(data.results) ? data.results : [];
      for (const j of results) {
        const mapped = mapJob(j, slug);
        if (mapped) out.push(mapped);
      }
      token = str(data.nextPage);
      if (!token || results.length === 0 || out.length >= MAX_POSTINGS) break;
    }
    if (out.length > 0) return out.slice(0, MAX_POSTINGS);
  } catch {
    // fall through to the widget feed
  }
  const { data } = await fetchJson<unknown>(ctx, `https://www.workable.com/api/accounts/${slug}?details=true`);
  const jobs = rec(data)?.jobs;
  const list = Array.isArray(jobs) ? (jobs as WkJob[]) : [];
  return list.map((j) => mapJob(j, slug)).filter((p): p is RawPosting => !!p).slice(0, MAX_POSTINGS);
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
  verify: (spec, ctx) => verifyFromFetch(() => fetchPostings(spec, ctx), () => companyName(spec, ctx))(),
};
