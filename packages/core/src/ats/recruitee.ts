import type { Adapter, FetchContext, RawPosting, SourceSpec } from "../types";
import { parseDate } from "../normalize";
import { fetchJson, htmlToText, joinLocation, safeUrl, slugOk, str, verifyFromFetch, MAX_POSTINGS } from "./common";

export function recruiteeSpec(slug: string): SourceSpec {
  return { type: "recruitee", url: `https://${slug}.recruitee.com`, apiUrl: `https://${slug}.recruitee.com/api/offers/`, atsSlug: slug };
}

function slugFromUrl(url: string): string | null {
  const u = safeUrl(url);
  if (!u) return null;
  const m = u.hostname.toLowerCase().match(/^([a-z0-9][a-z0-9-]*)\.recruitee\.com$/);
  return m && slugOk(m[1]) ? m[1]! : null;
}

interface RtOffer {
  id?: number | string;
  slug?: string;
  title?: string;
  careers_url?: string;
  careers_apply_url?: string;
  department?: string;
  location?: string;
  city?: string;
  country?: string;
  remote?: boolean;
  published_at?: string;
  created_at?: string;
  description?: string;
  requirements?: string;
  status?: string;
  employment_type_code?: string;
}

function mapOffer(o: RtOffer, slug: string): RawPosting | null {
  if (o.status && o.status !== "published") return null;
  const title = str(o.title);
  if (!title) return null;
  const url = str(o.careers_url) ?? (o.slug ? `https://${slug}.recruitee.com/o/${o.slug}` : undefined);
  if (!url) return null;
  const description = [htmlToText(o.description), htmlToText(o.requirements)].filter(Boolean).join("\n\n") || undefined;
  return {
    externalId: str(o.id),
    title,
    url,
    location: str(o.location) ?? joinLocation(o.city, o.country),
    department: str(o.department),
    employmentType: str(o.employment_type_code),
    remote: o.remote === true ? true : undefined,
    postedAt: parseDate(o.published_at) ?? parseDate(o.created_at),
    descriptionText: description,
  };
}

async function fetchPostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  const slug = spec.atsSlug;
  if (!slug) throw new Error("recruitee spec missing slug");
  const { data } = await fetchJson<{ offers?: RtOffer[] }>(ctx, `https://${slug}.recruitee.com/api/offers/`);
  const offers = Array.isArray(data.offers) ? data.offers : [];
  return offers.map((o) => mapOffer(o, slug)).filter((p): p is RawPosting => !!p).slice(0, MAX_POSTINGS);
}

export const recruitee: Adapter = {
  type: "recruitee",
  specFromUrl(url) {
    const slug = slugFromUrl(url);
    return slug ? recruiteeSpec(slug) : null;
  },
  fetchPostings,
  verify: (spec, ctx) => verifyFromFetch(() => fetchPostings(spec, ctx))(),
};
