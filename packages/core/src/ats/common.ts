import { SourceFetchError, type FetchContext, type FetchResponse, type RawPosting } from "../types";
import { stripHtml } from "../normalize";

export const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/i;
export const RESERVED_SLUGS = new Set([
  "embed", "jobs", "job", "api", "v1", "v0", "boards", "careers", "career", "www", "app", "apply", "static", "assets",
  "js", "css", "img", "images", "login", "signin", "signup", "about", "help", "support", "en", "en-us", "en-gb", "de", "fr",
]);

export function slugOk(slug: string | undefined | null): slug is string {
  return !!slug && SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug.toLowerCase());
}

export function safeUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

export function pathSegments(u: URL): string[] {
  return u.pathname.split("/").filter(Boolean);
}

export async function fetchJson<T = unknown>(ctx: FetchContext, url: string, init?: { maxBodyBytes?: number; timeoutMs?: number; method?: "GET" | "POST"; body?: unknown; headers?: Record<string, string> }): Promise<{ data: T; res: FetchResponse }> {
  const res = await ctx.fetchText(url, {
    method: init?.method ?? "GET",
    maxBodyBytes: init?.maxBodyBytes,
    timeoutMs: init?.timeoutMs,
    headers: { accept: "application/json", ...(init?.body !== undefined ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status >= 400) {
    const kind = res.status === 403 || res.status === 429 ? "blocked" : "http";
    throw new SourceFetchError(`HTTP ${res.status} from ${url}`, kind, res.status);
  }
  try {
    return { data: JSON.parse(res.body) as T, res };
  } catch {
    throw new SourceFetchError(`invalid JSON from ${url}`, "parse", res.status);
  }
}

export function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

export function str(v: unknown): string | undefined {
  if (typeof v === "string") {
    const s = v.trim();
    return s ? s : undefined;
  }
  if (typeof v === "number") return String(v);
  return undefined;
}

export function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Join location parts, dropping blanks and duplicates: ["London", "", "UK"] -> "London, UK". */
export function joinLocation(...parts: Array<unknown>): string | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const s = str(p);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.length ? out.join(", ") : undefined;
}

export function htmlToText(html: unknown): string | undefined {
  const s = str(html);
  if (!s) return undefined;
  const text = stripHtml(decodeEntities(s));
  return text || undefined;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

export function sample(postings: RawPosting[], n = 3): RawPosting[] {
  return postings.slice(0, n).map((p) => ({ externalId: p.externalId, title: p.title, url: p.url, location: p.location, postedAt: p.postedAt }));
}

export function verifyFromFetch(fetchPostings: () => Promise<RawPosting[]>, companyName?: () => Promise<string | undefined>) {
  return async () => {
    try {
      const postings = await fetchPostings();
      let name: string | undefined;
      if (companyName) {
        try {
          name = await companyName();
        } catch {
          name = undefined;
        }
      }
      return { ok: true, count: postings.length, sample: sample(postings), companyName: name };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  };
}

export const MAX_POSTINGS = 500;
