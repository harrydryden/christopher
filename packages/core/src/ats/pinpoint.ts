/** VERIFY: postings.json is undocumented. */
import type { Adapter, FetchContext, RawPosting, SourceSpec } from "../types";
import { parseDate } from "../normalize";
import { fetchJson, rec, safeUrl, slugOk, str, verifyFromFetch, MAX_POSTINGS } from "./common";

export function pinpointSpec(slug: string): SourceSpec {
  return { type: "pinpoint", url: `https://${slug}.pinpointhq.com`, apiUrl: `https://${slug}.pinpointhq.com/postings.json`, atsSlug: slug };
}

function slugFromUrl(url: string): string | null {
  const u = safeUrl(url);
  if (!u) return null;
  const m = u.hostname.toLowerCase().match(/^([a-z0-9][a-z0-9-]*)\.pinpointhq\.com$/);
  return m && slugOk(m[1]) ? m[1]! : null;
}

/** Pinpoint returns either `{name: "..."}` objects or plain strings. */
function labelOf(v: unknown): string | undefined {
  return str(v) ?? str(rec(v)?.name) ?? str(rec(v)?.title);
}

async function fetchPostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  const slug = spec.atsSlug;
  if (!slug) throw new Error("pinpoint spec missing slug");
  const { data } = await fetchJson<unknown>(ctx, `https://${slug}.pinpointhq.com/postings.json`);
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

export const pinpoint: Adapter = {
  type: "pinpoint",
  specFromUrl(url) {
    const slug = slugFromUrl(url);
    return slug ? pinpointSpec(slug) : null;
  },
  fetchPostings,
  verify: (spec, ctx) => verifyFromFetch(() => fetchPostings(spec, ctx))(),
};
