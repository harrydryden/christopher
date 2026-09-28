/** VERIFY: the /careers/list endpoint is undocumented; shapes confirmed against fixtures only. */
import type { FetchContext, RawPosting, SourceSpec } from "../types";
import { feedAdapter, fetchJson, joinLocation, mapPostings, rec, requireSlug, specOrNull, str, subdomainSlug, INLINE_DESCRIPTIONS_FETCH } from "./common";
import { parseDate } from "../normalize";

export function bambooSpec(slug: string): SourceSpec {
  return { type: "bamboohr", url: `https://${slug}.bamboohr.com/careers`, apiUrl: `https://${slug}.bamboohr.com/careers/list`, atsSlug: slug };
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
  const slug = requireSlug(spec);
  const { data } = await fetchJson<unknown>(ctx, `https://${slug}.bamboohr.com/careers/list`, INLINE_DESCRIPTIONS_FETCH);
  const result = rec(data)?.result;
  const list = Array.isArray(result) ? (result as BhJob[]) : [];
  return mapPostings(list, (j) => mapJob(j, slug));
}

export const bamboohr = feedAdapter({ type: "bamboohr", fromUrl: (url) => specOrNull(subdomainSlug(url, "bamboohr.com"), bambooSpec), read: fetchPostings });
