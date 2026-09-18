import type { Adapter, FetchContext, RawPosting, SourceSpec } from "../types";
import { parseDate } from "../normalize";
import { fetchJson, htmlToText, joinLocation, pathSegments, rec, safeUrl, slugOk, str, verifyFromFetch, MAX_POSTINGS } from "./common";

const API = "https://boards-api.greenhouse.io/v1/boards";
const EU_API = "https://boards-api.eu.greenhouse.io/v1/boards";

/**
 * The listing is requested without `content=true`: a board of 2,331 roles answers in 1-2 MB of
 * metadata, where the same board with every description inline answered in 41 MB and ran the
 * worker out of heap while decoding the body. Descriptions come one role at a time from
 * `/jobs/{id}` (see `fetchGreenhouseDescription`), which the scan queues rather than reads inline.
 */
const LIST_MAX_BYTES = 8_000_000;
const DETAIL_MAX_BYTES = 2_000_000;

export function greenhouseSpec(slug: string): SourceSpec {
  return { type: "greenhouse", url: `https://job-boards.greenhouse.io/${slug}`, apiUrl: `${API}/${slug}/jobs`, atsSlug: slug };
}

/** Sources stored against the EU host keep using it; everything else is the default board API. */
function apiBase(spec: SourceSpec): string {
  const host = spec.apiUrl ? safeUrl(spec.apiUrl)?.hostname.toLowerCase() : undefined;
  return host === "boards-api.eu.greenhouse.io" ? EU_API : API;
}

function slugFromUrl(url: string): string | null {
  const u = safeUrl(url);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  const segs = pathSegments(u);
  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io" || host === "boards.eu.greenhouse.io" || host === "job-boards.eu.greenhouse.io") {
    if (segs[0] === "embed") {
      const forParam = u.searchParams.get("for");
      return slugOk(forParam) ? forParam : null;
    }
    return slugOk(segs[0]) ? segs[0] : null;
  }
  if (host === "boards-api.greenhouse.io" || host === "boards-api.eu.greenhouse.io") {
    // /v1/boards/{slug}/...
    if (segs[0] === "v1" && segs[1] === "boards" && slugOk(segs[2])) return segs[2];
    return null;
  }
  if (host === "grnh.se") return slugOk(segs[0]) ? segs[0] : null;
  return null;
}

interface GhJob {
  id?: number | string;
  internal_job_id?: number | string;
  title?: string;
  updated_at?: string;
  first_published?: string;
  absolute_url?: string;
  location?: { name?: string };
  content?: string;
  departments?: Array<{ name?: string }>;
  offices?: Array<{ name?: string; location?: string }>;
  metadata?: Array<{ name?: string; value?: unknown }>;
}

/**
 * The listing carries no description, so `descriptionHtml` and `descriptionText` are undefined
 * at scan time for every posting. The scan defers description-matching gates for them and queues
 * one `fetch_description` task per posting instead.
 */
function mapJob(j: GhJob): RawPosting | null {
  const title = str(j.title);
  const url = str(j.absolute_url);
  if (!title || !url) return null;
  const location = str(j.location?.name);
  const offices = (j.offices ?? []).map((o) => str(o.name)).filter((s): s is string => !!s);
  const locations = [...new Set([...(location ? [location] : []), ...offices])];
  const department = (j.departments ?? []).map((d) => str(d.name)).filter(Boolean).join(" / ") || undefined;
  const salary = (j.metadata ?? []).find((m) => /salary|compensation|pay range/i.test(str(m.name) ?? ""));
  return {
    externalId: str(j.id),
    title,
    url,
    location,
    locations: locations.length > 1 ? locations : undefined,
    department,
    remote: /remote/i.test(location ?? "") || undefined,
    postedAt: parseDate(j.first_published),
    updatedAt: parseDate(j.updated_at),
    salaryText: salary ? str(salary.value) : undefined,
  };
}

async function fetchPostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  const slug = spec.atsSlug;
  if (!slug) throw new Error("greenhouse spec missing slug");
  const { data } = await fetchJson<{ jobs?: GhJob[] }>(ctx, `${apiBase(spec)}/${slug}/jobs`, { maxBodyBytes: LIST_MAX_BYTES, timeoutMs: 60_000 });
  if (!Array.isArray(data.jobs)) throw new Error("Greenhouse response is missing its jobs array");
  if (data.jobs.length > MAX_POSTINGS) throw new Error(`Greenhouse board exceeds the ${MAX_POSTINGS}-role processing limit`);
  const postings = data.jobs.map(mapJob).filter((p): p is RawPosting => !!p);
  if (postings.length !== data.jobs.length) throw new Error("Greenhouse response contains invalid roles; refusing an incomplete reconciliation");
  return postings;
}

/**
 * One role's description. `GET /v1/boards/{slug}/jobs/{id}` returns that posting with its `content`
 * (HTML, entity-encoded). A board with no description for a role answers without `content`, which
 * returns undefined and lets the caller fall back to the posting page.
 */
export async function fetchGreenhouseDescription(spec: SourceSpec, posting: RawPosting, ctx: FetchContext): Promise<string | undefined> {
  const slug = spec.atsSlug;
  const id = posting.externalId;
  if (!slug || !id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return undefined;
  const { data } = await fetchJson<unknown>(ctx, `${apiBase(spec)}/${slug}/jobs/${id}`, { maxBodyBytes: DETAIL_MAX_BYTES });
  return htmlToText(rec(data)?.content);
}

async function companyName(spec: SourceSpec, ctx: FetchContext): Promise<string | undefined> {
  const { data } = await fetchJson<unknown>(ctx, `${apiBase(spec)}/${spec.atsSlug}`);
  return str(rec(data)?.name);
}

export const greenhouse: Adapter = {
  type: "greenhouse",
  descriptionsPerPosting: true,
  specFromUrl(url) {
    const slug = slugFromUrl(url);
    return slug ? greenhouseSpec(slug) : null;
  },
  fetchPostings,
  verify: (spec, ctx) => verifyFromFetch(() => fetchPostings(spec, ctx), () => companyName(spec, ctx))(),
};

export { joinLocation as _ghJoin };
