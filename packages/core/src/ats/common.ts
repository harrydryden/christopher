import { IncompleteListingError, SourceFetchError, type FetchContext, type FetchResponse, type RawPosting, type VerifyResult } from "../types";
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
    // A 429 is the host pacing us, not refusing us: it retries tomorrow rather than marking the
    // source blocked, which nothing but a person undoes.
    const kind = res.status === 403 ? "blocked" : res.status === 429 || res.status === 503 ? "rate_limited" : "http";
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

/**
 * A verification, and whether a failure was the host asking us to come back later (a 429, a 503, a
 * timeout, a dropped connection) rather than a verdict on the board. Discovery retries a company
 * whose only good candidate failed that way instead of recording that nothing was found.
 */
export type Verification = VerifyResult & { transient?: boolean };

/** True for a failure that says nothing about the board: retrying later may well succeed. */
export function isTransientFailure(err: unknown): boolean {
  if (err instanceof SourceFetchError) {
    return err.kind === "rate_limited" || err.kind === "timeout" || err.kind === "network" || (err.kind === "http" && (err.status ?? 0) >= 500);
  }
  // The fetcher's refusal to wait any longer for a busy host.
  return err instanceof Error && err.name === "HostBusyError";
}

/** One bounded read of a listing: the roles read and, when the feed says, how many it holds in all. */
export interface ListingRead {
  postings: RawPosting[];
  total?: number;
  companyName?: string;
}

/**
 * Verification reads one page. It establishes that the board exists and serves roles, and samples
 * them; whether a listing is complete is the scan's business, so a big board costs one request here
 * rather than its whole length. The count is the feed's own total when it reports one.
 */
export function verifyFromRead(read: () => Promise<ListingRead>, companyName?: () => Promise<string | undefined>) {
  return async (): Promise<Verification> => {
    try {
      // A read cut short by its page budget still proves the board exists and serves roles.
      const listing = await read().catch((err: unknown): ListingRead => {
        if (err instanceof IncompleteListingError) return { postings: err.postings };
        throw err;
      });
      let name = listing.companyName;
      if (!name && companyName) {
        try {
          name = await companyName();
        } catch {
          name = undefined;
        }
      }
      return { ok: true, count: listing.total ?? listing.postings.length, sample: sample(listing.postings), companyName: name };
    } catch (err) {
      return { ok: false, error: (err as Error).message, transient: isTransientFailure(err) };
    }
  };
}

/** `verifyFromRead` for a feed that is a single request. */
export function verifyFromFetch(fetchPostings: () => Promise<RawPosting[]>, companyName?: () => Promise<string | undefined>) {
  return verifyFromRead(async () => ({ postings: await fetchPostings() }), companyName);
}

/**
 * The body cap for a feed that carries every description inline (Lever, Ashby, Recruitee, Personio,
 * the Workable widget, Pinpoint, BambooHR, Eightfold). A few hundred roles with their descriptions
 * pass the fetcher's 5 MB default, and a refused body fails every scan and every verification of the
 * board. The fetcher's own hard maximum still applies.
 */
export const INLINE_DESCRIPTIONS_MAX_BYTES = 32_000_000;
export const INLINE_DESCRIPTIONS_FETCH = { maxBodyBytes: INLINE_DESCRIPTIONS_MAX_BYTES, timeoutMs: 60_000 } as const;

/**
 * The most postings any adapter returns from one source. Greenhouse boards
 * exist at 2,000+ roles, so 500 silently hid most of a large employer — and a
 * feed whose order shifted between scans moved roles across the cutoff and
 * closed them. Every adapter slices to this, and the scan marks itself partial
 * when a source reaches it, so a capped listing can never close a role.
 */
export const MAX_POSTINGS = 10_000;
