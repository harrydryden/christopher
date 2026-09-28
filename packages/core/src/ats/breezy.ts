/** VERIFY: the /json endpoint is undocumented. */
import type { FetchContext, RawPosting, SourceSpec } from "../types";
import { parseDate } from "../normalize";
import { feedAdapter, fetchJson, joinLocation, rec, requireSlug, specOrNull, str, subdomainSlug, MAX_POSTINGS } from "./common";

export function breezySpec(slug: string): SourceSpec {
  return { type: "breezy", url: `https://${slug}.breezy.hr`, apiUrl: `https://${slug}.breezy.hr/json`, atsSlug: slug };
}

async function fetchPostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  const slug = requireSlug(spec);
  const { data } = await fetchJson<unknown>(ctx, `https://${slug}.breezy.hr/json`);
  const list = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  const out: RawPosting[] = [];
  for (const raw of list) {
    const title = str(raw.name);
    const id = str(raw.id) ?? str(raw.friendly_id);
    const url = str(raw.url) ?? (raw.friendly_id ? `https://${slug}.breezy.hr/p/${str(raw.friendly_id)}` : undefined);
    if (!title || !url) continue;
    const loc = rec(raw.location);
    out.push({
      externalId: id,
      title,
      url,
      location: str(loc?.name) ?? joinLocation(loc?.city, rec(loc?.country)?.name ?? loc?.country),
      department: str(raw.department) ?? str(rec(raw.department)?.name),
      employmentType: str(rec(raw.type)?.name) ?? str(raw.type),
      remote: str(rec(raw.location)?.is_remote) === "true" || raw.is_remote === true ? true : undefined,
      postedAt: parseDate(raw.published_date) ?? parseDate(raw.creation_date),
    });
  }
  return out.slice(0, MAX_POSTINGS);
}

export const breezy = feedAdapter({ type: "breezy", fromUrl: (url) => specOrNull(subdomainSlug(url, "breezy.hr"), breezySpec), read: fetchPostings });
