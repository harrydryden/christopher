/** VERIFY: postings.json is undocumented. */
import type { FetchContext, RawPosting, SourceSpec } from "../types";
import { parseDate } from "../normalize";
import { feedAdapter, fetchJson, rec, requireSlug, specOrNull, str, subdomainSlug, INLINE_DESCRIPTIONS_FETCH, MAX_POSTINGS } from "./common";

export function pinpointSpec(slug: string): SourceSpec {
  return { type: "pinpoint", url: `https://${slug}.pinpointhq.com`, apiUrl: `https://${slug}.pinpointhq.com/postings.json`, atsSlug: slug };
}

/** Pinpoint returns either `{name: "..."}` objects or plain strings. */
function labelOf(v: unknown): string | undefined {
  return str(v) ?? str(rec(v)?.name) ?? str(rec(v)?.title);
}

async function fetchPostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  const slug = requireSlug(spec);
  const { data } = await fetchJson<unknown>(ctx, `https://${slug}.pinpointhq.com/postings.json`, INLINE_DESCRIPTIONS_FETCH);
  const list = Array.isArray(rec(data)?.data) ? (rec(data)!.data as Array<Record<string, unknown>>) : Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  const out: RawPosting[] = [];
  for (const raw of list) {
    const title = str(raw.title);
    const url = str(raw.url);
    if (!title || !url) continue;
    out.push({
      externalId: str(raw.id),
      title,
      url,
      location: labelOf(raw.location),
      department: labelOf(raw.department),
      employmentType: labelOf(raw.employment_type),
      postedAt: parseDate(raw.created_at) ?? parseDate(raw.published_at),
    });
  }
  return out.slice(0, MAX_POSTINGS);
}

export const pinpoint = feedAdapter({ type: "pinpoint", fromUrl: (url) => specOrNull(subdomainSlug(url, "pinpointhq.com"), pinpointSpec), read: fetchPostings });
