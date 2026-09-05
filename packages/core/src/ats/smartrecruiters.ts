import type { Adapter, FetchContext, RawPosting, SourceSpec } from "../types";
import { parseDate } from "../normalize";
import { fetchJson, htmlToText, joinLocation, pathSegments, rec, safeUrl, slugOk, str, verifyFromFetch, MAX_POSTINGS } from "./common";

const API = "https://api.smartrecruiters.com/v1/companies";

export function smartRecruitersSpec(slug: string): SourceSpec {
  return { type: "smartrecruiters", url: `https://jobs.smartrecruiters.com/${slug}`, apiUrl: `${API}/${slug}/postings`, atsSlug: slug };
}

function slugFromUrl(url: string): string | null {
  const u = safeUrl(url);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  const segs = pathSegments(u);
  if (host === "jobs.smartrecruiters.com" || host === "careers.smartrecruiters.com") return slugOk(segs[0]) ? segs[0] : null;
  if (host === "api.smartrecruiters.com" && segs[0] === "v1" && segs[1] === "companies") return slugOk(segs[2]) ? segs[2] : null;
  return null;
}

interface SrPosting {
  id?: string;
  uuid?: string;
  name?: string;
  refNumber?: string;
  releasedDate?: string;
  location?: { city?: string; region?: string; country?: string; remote?: boolean; fullLocation?: string };
  department?: { label?: string };
  function?: { label?: string };
  typeOfEmployment?: { label?: string };
  ref?: string;
  company?: { identifier?: string; name?: string };
}

function mapPosting(p: SrPosting, slug: string): RawPosting | null {
  const title = str(p.name);
  const id = str(p.id) ?? str(p.uuid);
  if (!title || !id) return null;
  const location = str(p.location?.fullLocation) ?? joinLocation(p.location?.city, p.location?.region, p.location?.country);
  return {
    externalId: id,
    title,
    url: `https://jobs.smartrecruiters.com/${slug}/${id}`,
    location,
    department: str(p.department?.label) ?? str(p.function?.label),
    employmentType: str(p.typeOfEmployment?.label),
    remote: p.location?.remote === true ? true : undefined,
    postedAt: parseDate(p.releasedDate),
  };
}

async function fetchPostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  const slug = spec.atsSlug;
  if (!slug) throw new Error("smartrecruiters spec missing slug");
  const out: RawPosting[] = [];
  const limit = 100;
  let offset = 0;
  for (let page = 0; page < 10; page++) {
    const { data } = await fetchJson<{ content?: SrPosting[]; totalFound?: number; offset?: number; limit?: number }>(
      ctx,
      `${API}/${slug}/postings?limit=${limit}&offset=${offset}`,
    );
    const content = Array.isArray(data.content) ? data.content : [];
    for (const p of content) {
      const mapped = mapPosting(p, slug);
      if (mapped) out.push(mapped);
    }
    const total = typeof data.totalFound === "number" ? data.totalFound : content.length;
    offset += limit;
    if (offset >= total || content.length === 0 || out.length >= MAX_POSTINGS) break;
  }
  return out.slice(0, MAX_POSTINGS);
}

/** SmartRecruiters keeps descriptions behind a per-posting call. */
export async function fetchSmartRecruitersDescription(spec: SourceSpec, posting: RawPosting, ctx: FetchContext): Promise<string | undefined> {
  if (!spec.atsSlug || !posting.externalId) return undefined;
  const { data } = await fetchJson<unknown>(ctx, `${API}/${spec.atsSlug}/postings/${posting.externalId}`);
  const sections = rec(rec(rec(data)?.jobAd)?.sections);
  if (!sections) return undefined;
  const parts: string[] = [];
  for (const key of ["companyDescription", "jobDescription", "qualifications", "additionalInformation"]) {
    const text = htmlToText(rec(sections[key])?.text);
    if (text) parts.push(text);
  }
  return parts.length ? parts.join("\n\n") : undefined;
}

async function companyName(spec: SourceSpec, ctx: FetchContext): Promise<string | undefined> {
  const { data } = await fetchJson<{ content?: SrPosting[] }>(ctx, `${API}/${spec.atsSlug}/postings?limit=1&offset=0`);
  return str(data.content?.[0]?.company?.name);
}

export const smartrecruiters: Adapter = {
  type: "smartrecruiters",
  specFromUrl(url) {
    const slug = slugFromUrl(url);
    return slug ? smartRecruitersSpec(slug) : null;
  },
  fetchPostings,
  verify: (spec, ctx) => verifyFromFetch(() => fetchPostings(spec, ctx), () => companyName(spec, ctx))(),
};
