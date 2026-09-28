import type { FetchContext, RawPosting, SourceSpec } from "../types";
import { parseDate } from "../normalize";
import { extraLocations, feedAdapter, fetchJson, htmlToText, mapPostings, pathSegments, rec, requireSlug, safeUrl, slugOk, specOrNull, str, INLINE_DESCRIPTIONS_FETCH } from "./common";

export function ashbySpec(slug: string): SourceSpec {
  return {
    type: "ashby",
    url: `https://jobs.ashbyhq.com/${slug}`,
    apiUrl: `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`,
    atsSlug: slug,
  };
}

function slugFromUrl(url: string): string | null {
  const u = safeUrl(url);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  const segs = pathSegments(u);
  if (host === "jobs.ashbyhq.com") return slugOk(segs[0]) ? segs[0] : null;
  if (host === "api.ashbyhq.com" && segs[0] === "posting-api" && segs[1] === "job-board") return slugOk(segs[2]) ? segs[2] : null;
  return null;
}

interface AshbyJob {
  id?: string;
  title?: string;
  department?: string;
  team?: string;
  employmentType?: string;
  location?: string;
  secondaryLocations?: Array<{ location?: string }>;
  publishedAt?: string;
  isListed?: boolean;
  isRemote?: boolean;
  jobUrl?: string;
  applyUrl?: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
  compensation?: { compensationTierSummary?: string; scrapeableCompensationSalarySummary?: string };
}

function mapJob(j: AshbyJob): RawPosting | null {
  if (j.isListed === false) return null;
  const title = str(j.title);
  const url = str(j.jobUrl) ?? str(j.applyUrl);
  if (!title || !url) return null;
  const location = str(j.location);
  const secondary = (j.secondaryLocations ?? []).map((s) => str(s.location)).filter((s): s is string => !!s);
  return {
    externalId: str(j.id),
    title,
    url,
    location,
    locations: extraLocations(location, secondary),
    department: [str(j.department), str(j.team)].filter(Boolean).join(" / ") || undefined,
    employmentType: str(j.employmentType),
    remote: j.isRemote === true ? true : undefined,
    postedAt: parseDate(j.publishedAt),
    descriptionHtml: str(j.descriptionHtml),
    descriptionText: str(j.descriptionPlain) ?? htmlToText(j.descriptionHtml),
    salaryText: str(j.compensation?.scrapeableCompensationSalarySummary) ?? str(j.compensation?.compensationTierSummary),
  };
}

async function fetchPostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  const { data } = await fetchJson<unknown>(ctx, ashbySpec(requireSlug(spec)).apiUrl!, INLINE_DESCRIPTIONS_FETCH);
  const jobs = rec(data)?.jobs;
  const list = Array.isArray(jobs) ? (jobs as AshbyJob[]) : [];
  return mapPostings(list, mapJob);
}

export const ashby = feedAdapter({ type: "ashby", fromUrl: (url) => specOrNull(slugFromUrl(url), ashbySpec), read: fetchPostings });
