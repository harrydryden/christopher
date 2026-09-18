import type { Adapter, FetchContext, RawPosting, SourceSpec } from "../types";
import { parseDate } from "../normalize";
import { fetchJson, htmlToText, pathSegments, safeUrl, slugOk, str, verifyFromFetch, MAX_POSTINGS } from "./common";

export function leverSpec(slug: string, eu = false): SourceSpec {
  const api = eu ? "https://api.eu.lever.co/v0/postings" : "https://api.lever.co/v0/postings";
  const board = eu ? "https://jobs.eu.lever.co" : "https://jobs.lever.co";
  return { type: "lever", url: `${board}/${slug}`, apiUrl: `${api}/${slug}?mode=json`, atsSlug: slug, atsSite: eu ? "eu" : undefined };
}

function parse(url: string): { slug: string; eu: boolean } | null {
  const u = safeUrl(url);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  const segs = pathSegments(u);
  if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") {
    return slugOk(segs[0]) ? { slug: segs[0], eu: host.includes(".eu.") } : null;
  }
  if (host === "api.lever.co" || host === "api.eu.lever.co") {
    if (segs[0] === "v0" && segs[1] === "postings" && slugOk(segs[2])) return { slug: segs[2], eu: host.includes(".eu.") };
  }
  return null;
}

interface LeverPosting {
  id?: string;
  text?: string;
  categories?: { commitment?: string; department?: string; location?: string; team?: string; allLocations?: string[] };
  description?: string;
  descriptionPlain?: string;
  /** The body of the posting after the opening paragraphs: requirements, benefits, and so on. */
  lists?: Array<{ text?: string; content?: string }>;
  additional?: string;
  additionalPlain?: string;
  hostedUrl?: string;
  applyUrl?: string;
  createdAt?: number;
  workplaceType?: string;
  country?: string;
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}

/**
 * Lever splits a posting into an opening (`description`), a series of headed lists (requirements,
 * benefits, what we offer) and a closing note (`additional`). `descriptionPlain` is the opening
 * alone, so a gate matching on the description — which keys on exactly this text — never saw the
 * requirements, where the words a search is usually written around live. All three are folded in.
 */
function descriptionTextFor(p: LeverPosting): string | undefined {
  const lists = (p.lists ?? []).map((list) => {
    const heading = str(list?.text);
    const body = htmlToText(list?.content);
    return body ? (heading ? `${heading}\n${body}` : body) : undefined;
  });
  const parts = [str(p.descriptionPlain) ?? htmlToText(p.description), ...lists, str(p.additionalPlain) ?? htmlToText(p.additional)];
  const text = parts.filter((part): part is string => !!part).join("\n\n");
  return text || undefined;
}

function mapPosting(p: LeverPosting): RawPosting | null {
  const title = str(p.text);
  const url = str(p.hostedUrl) ?? str(p.applyUrl);
  if (!title || !url) return null;
  const location = str(p.categories?.location);
  const all = (p.categories?.allLocations ?? []).map((l) => str(l)).filter((s): s is string => !!s);
  const locations = [...new Set([...(location ? [location] : []), ...all])];
  const remote = p.workplaceType === "remote" ? true : /remote/i.test(location ?? "") ? true : undefined;
  const sr = p.salaryRange;
  const salaryText = sr && (sr.min || sr.max) ? `${sr.currency ?? ""} ${sr.min ?? ""}${sr.max ? ` - ${sr.max}` : ""}${sr.interval ? ` ${sr.interval}` : ""}`.trim() : undefined;
  return {
    externalId: str(p.id),
    title,
    url,
    location,
    locations: locations.length > 1 ? locations : undefined,
    department: [str(p.categories?.department), str(p.categories?.team)].filter(Boolean).join(" / ") || undefined,
    employmentType: str(p.categories?.commitment),
    remote,
    postedAt: parseDate(p.createdAt),
    descriptionHtml: str(p.description),
    descriptionText: descriptionTextFor(p),
    salaryText,
  };
}

async function fetchPostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  if (!spec.atsSlug) throw new Error("lever spec missing slug");
  const api = spec.apiUrl ?? leverSpec(spec.atsSlug, spec.atsSite === "eu").apiUrl!;
  const { data } = await fetchJson<LeverPosting[] | { data?: LeverPosting[] }>(ctx, api);
  const list = Array.isArray(data) ? data : Array.isArray((data as { data?: LeverPosting[] }).data) ? (data as { data: LeverPosting[] }).data : [];
  return list.map(mapPosting).filter((p): p is RawPosting => !!p).slice(0, MAX_POSTINGS);
}

export const lever: Adapter = {
  type: "lever",
  specFromUrl(url) {
    const r = parse(url);
    return r ? leverSpec(r.slug, r.eu) : null;
  },
  fetchPostings,
  verify: (spec, ctx) => verifyFromFetch(() => fetchPostings(spec, ctx))(),
};
