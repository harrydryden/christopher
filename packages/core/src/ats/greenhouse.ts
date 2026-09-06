import type { Adapter, FetchContext, RawPosting, SourceSpec } from "../types";
import { parseDate } from "../normalize";
import { fetchJson, htmlToText, joinLocation, pathSegments, rec, safeUrl, slugOk, str, verifyFromFetch } from "./common";

const API = "https://boards-api.greenhouse.io/v1/boards";

export function greenhouseSpec(slug: string): SourceSpec {
  return { type: "greenhouse", url: `https://job-boards.greenhouse.io/${slug}`, apiUrl: `${API}/${slug}/jobs?content=true`, atsSlug: slug };
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
    descriptionHtml: str(j.content) ? j.content : undefined,
    descriptionText: htmlToText(j.content),
    salaryText: salary ? str(salary.value) : undefined,
  };
}

async function fetchPostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  const slug = spec.atsSlug;
  if (!slug) throw new Error("greenhouse spec missing slug");
  const { data } = await fetchJson<{ jobs?: GhJob[] }>(ctx, `${API}/${slug}/jobs?content=true`, { maxBodyBytes: 60_000_000, timeoutMs: 60_000 });
  if (!Array.isArray(data.jobs)) throw new Error("Greenhouse response is missing its jobs array");
  if (data.jobs.length > 10_000) throw new Error("Greenhouse board exceeds the 10,000-role processing limit");
  const postings = data.jobs.map(mapJob).filter((p): p is RawPosting => !!p);
  if (postings.length !== data.jobs.length) throw new Error("Greenhouse response contains invalid roles; refusing an incomplete reconciliation");
  return postings;
}

async function companyName(spec: SourceSpec, ctx: FetchContext): Promise<string | undefined> {
  const { data } = await fetchJson<unknown>(ctx, `${API}/${spec.atsSlug}`);
  return str(rec(data)?.name);
}

export const greenhouse: Adapter = {
  type: "greenhouse",
  specFromUrl(url) {
    const slug = slugFromUrl(url);
    return slug ? greenhouseSpec(slug) : null;
  },
  fetchPostings,
  verify: (spec, ctx) => verifyFromFetch(() => fetchPostings(spec, ctx), () => companyName(spec, ctx))(),
};

export { joinLocation as _ghJoin };
