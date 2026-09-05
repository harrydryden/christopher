/** VERIFY: the /careers/list endpoint is undocumented; shapes confirmed against fixtures only. */
import type { Adapter, FetchContext, RawPosting, SourceSpec } from "../types";
import { fetchJson, joinLocation, rec, safeUrl, slugOk, str, verifyFromFetch, MAX_POSTINGS } from "./common";
import { parseDate } from "../normalize";

export function bambooSpec(slug: string): SourceSpec {
  return { type: "bamboohr", url: `https://${slug}.bamboohr.com/careers`, apiUrl: `https://${slug}.bamboohr.com/careers/list`, atsSlug: slug };
}

function slugFromUrl(url: string): string | null {
  const u = safeUrl(url);
  if (!u) return null;
  const m = u.hostname.toLowerCase().match(/^([a-z0-9][a-z0-9-]*)\.bamboohr\.com$/);
  return m && slugOk(m[1]) ? m[1]! : null;
}

interface BhJob {
  id?: string | number;
  jobOpeningName?: string;
  departmentLabel?: string;
  employmentStatusLabel?: string;
  location?: { city?: string; state?: string; country?: string };
  atsLocation?: string;
  isRemote?: boolean | string;
  datePosted?: string;
}

function mapJob(j: BhJob, slug: string): RawPosting | null {
  const title = str(j.jobOpeningName);
  const id = str(j.id);
  if (!title || !id) return null;
  const remote = j.isRemote === true || j.isRemote === "true" || j.isRemote === "1";
  return {
    externalId: id,
    title,
    url: `https://${slug}.bamboohr.com/careers/${id}`,
    location: str(j.atsLocation) ?? joinLocation(j.location?.city, j.location?.state, j.location?.country) ?? (remote ? "Remote" : undefined),
    department: str(j.departmentLabel),
    employmentType: str(j.employmentStatusLabel),
    remote: remote ? true : undefined,
    postedAt: parseDate(j.datePosted),
  };
}

async function fetchPostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  const slug = spec.atsSlug;
  if (!slug) throw new Error("bamboohr spec missing slug");
  const { data } = await fetchJson<unknown>(ctx, `https://${slug}.bamboohr.com/careers/list`);
  const result = rec(data)?.result;
  const list = Array.isArray(result) ? (result as BhJob[]) : [];
  return list.map((j) => mapJob(j, slug)).filter((p): p is RawPosting => !!p).slice(0, MAX_POSTINGS);
}

export const bamboohr: Adapter = {
  type: "bamboohr",
  specFromUrl(url) {
    const slug = slugFromUrl(url);
    return slug ? bambooSpec(slug) : null;
  },
  fetchPostings,
  verify: (spec, ctx) => verifyFromFetch(() => fetchPostings(spec, ctx))(),
};
