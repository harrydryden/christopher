/** VERIFY: the /json endpoint is undocumented. */
import type { Adapter, FetchContext, RawPosting, SourceSpec } from "../types";
import { parseDate } from "../normalize";
import { fetchJson, joinLocation, rec, safeUrl, slugOk, str, verifyFromFetch, MAX_POSTINGS } from "./common";

export function breezySpec(slug: string): SourceSpec {
  return { type: "breezy", url: `https://${slug}.breezy.hr`, apiUrl: `https://${slug}.breezy.hr/json`, atsSlug: slug };
}

function slugFromUrl(url: string): string | null {
  const u = safeUrl(url);
  if (!u) return null;
  const m = u.hostname.toLowerCase().match(/^([a-z0-9][a-z0-9-]*)\.breezy\.hr$/);
  return m && slugOk(m[1]) ? m[1]! : null;
}

async function fetchPostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  const slug = spec.atsSlug;
  if (!slug) throw new Error("breezy spec missing slug");
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

export const breezy: Adapter = {
  type: "breezy",
  specFromUrl(url) {
    const slug = slugFromUrl(url);
    return slug ? breezySpec(slug) : null;
  },
  fetchPostings,
  verify: (spec, ctx) => verifyFromFetch(() => fetchPostings(spec, ctx))(),
};
