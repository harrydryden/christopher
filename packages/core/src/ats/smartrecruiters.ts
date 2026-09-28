import { IncompleteListingError, type FetchContext, type RawPosting, type SourceSpec } from "../types";
import { parseDate } from "../normalize";
import { feedAdapter, fetchJson, htmlToText, joinLocation, pathSegments, readOffsetPages, rec, requireSlug, safeUrl, slugOk, specOrNull, str, type PagedRead } from "./common";

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

const PAGE_SIZE = 100;
/**
 * Two hundred pages of 100, bounded by the posting cap: every realistic board is read whole. A
 * board longer than that is reported incomplete rather than complete.
 */
const MAX_PAGES = 200;

/** Up to `maxPages` pages, the company's name read from the first posting. */
async function readPages(spec: SourceSpec, ctx: FetchContext, maxPages: number): Promise<PagedRead> {
  const slug = requireSlug(spec);
  return readOffsetPages({
    pageSize: PAGE_SIZE,
    maxPages,
    totalPolicy: "latest",
    fetchPage: async (offset) => {
      const { data } = await fetchJson<{ content?: SrPosting[]; totalFound?: number }>(ctx, `${API}/${slug}/postings?limit=${PAGE_SIZE}&offset=${offset}`);
      const content = Array.isArray(data.content) ? data.content : [];
      return { items: content, total: data.totalFound, companyName: str(content[0]?.company?.name) };
    },
    map: (p) => mapPosting(p, slug),
  });
}

async function fetchPostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  const { postings, more, total, nextOffset } = await readPages(spec, ctx, MAX_PAGES);
  // The page budget ran out with roles still unread. Returning what was read as a complete listing
  // is what closes roles that are simply on the next page.
  if (more) {
    const left = total === undefined ? "more roles" : `${total - nextOffset} roles`;
    throw new IncompleteListingError(`SmartRecruiters listing stopped after ${postings.length} roles with ${left} unread; this scan cannot close roles`, postings);
  }
  return postings;
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

export const smartrecruiters = feedAdapter({
  type: "smartrecruiters",
  // The listing carries no description and `fetchSmartRecruitersDescription` serves one role at a
  // time, so the scan defers description gates and queues the fetches instead of making up to one
  // 2-second detail request per matching role inside the scan task.
  descriptionsPerPosting: true,
  fromUrl: (url) => specOrNull(slugFromUrl(url), smartRecruitersSpec),
  read: fetchPostings,
  // One page, which carries the company's name as well as the board's total.
  verifyRead: (spec, ctx) => readPages(spec, ctx, 1),
  companyName,
});
