import { IncompleteListingError, type Adapter, type FetchContext, type RawPosting, type SourceSpec } from "../types";
import { parseDate } from "../normalize";
import { fetchJson, htmlToText, joinLocation, pathSegments, rec, safeUrl, slugOk, str, verifyFromRead, MAX_POSTINGS, type ListingRead } from "./common";

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

/** Up to `maxPages` pages; `unread` is how many roles the board holds past the last page read. */
async function readPages(spec: SourceSpec, ctx: FetchContext, maxPages: number): Promise<ListingRead & { unread: number | "unknown" }> {
  const slug = spec.atsSlug;
  if (!slug) throw new Error("smartrecruiters spec missing slug");
  const out: RawPosting[] = [];
  const limit = PAGE_SIZE;
  let offset = 0;
  let total: number | undefined;
  let companyName: string | undefined;
  let unread: number | "unknown" = 0;
  for (let page = 0; page < maxPages; page++) {
    const { data } = await fetchJson<{ content?: SrPosting[]; totalFound?: number; offset?: number; limit?: number }>(
      ctx,
      `${API}/${slug}/postings?limit=${limit}&offset=${offset}`,
    );
    const content = Array.isArray(data.content) ? data.content : [];
    for (const p of content) {
      const mapped = mapPosting(p, slug);
      if (mapped) out.push(mapped);
    }
    companyName ??= str(content[0]?.company?.name);
    if (typeof data.totalFound === "number") total = data.totalFound;
    offset += limit;
    // Without a total, only a short page proves the board has ended: a full one may have a
    // successor, and treating it as the last page closed every role past it.
    unread = content.length === 0 ? 0 : total !== undefined ? Math.max(0, total - offset) : content.length < limit ? 0 : "unknown";
    if (unread === 0 || out.length >= MAX_POSTINGS) break;
  }
  return { postings: out.slice(0, MAX_POSTINGS), total, companyName, unread };
}

async function fetchPostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  const { postings, unread } = await readPages(spec, ctx, MAX_PAGES);
  // The page budget ran out with roles still unread. Returning what was read as a complete listing
  // is what closes roles that are simply on the next page.
  if (unread !== 0) {
    const left = unread === "unknown" ? "more roles" : `${unread} roles`;
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

export const smartrecruiters: Adapter = {
  type: "smartrecruiters",
  // The listing carries no description and `fetchSmartRecruitersDescription` serves one role at a
  // time, so the scan defers description gates and queues the fetches instead of making up to one
  // 2-second detail request per matching role inside the scan task.
  descriptionsPerPosting: true,
  specFromUrl(url) {
    const slug = slugFromUrl(url);
    return slug ? smartRecruitersSpec(slug) : null;
  },
  fetchPostings,
  // One page, which carries the company's name as well as the board's total.
  verify: (spec, ctx) => verifyFromRead(() => readPages(spec, ctx, 1), () => companyName(spec, ctx))(),
};
