/** Shared, runtime-agnostic types for scraping, discovery and gating. */

export type SourceType =
  | "greenhouse" | "lever" | "ashby" | "workable" | "smartrecruiters" | "recruitee" | "personio"
  | "bamboohr" | "workday" | "pinpoint" | "breezy"
  | "teamtailor" | "icims" | "jobvite" | "jazzhr" | "rippling" | "successfactors" | "eightfold"
  | "jsonld" | "rss" | "html";

export interface RawPosting {
  /** Stable identifier from the ATS when it provides one. */
  externalId?: string;
  title: string;
  /** Public URL of the posting. */
  url: string;
  /** Primary location string as displayed by the source. */
  location?: string;
  /** All location strings when a posting lists several. */
  locations?: string[];
  department?: string;
  employmentType?: string;
  remote?: boolean;
  /** Published date when the source provides one. */
  postedAt?: Date;
  updatedAt?: Date;
  descriptionHtml?: string;
  descriptionText?: string;
  salaryText?: string;
}

export interface HtmlRecipe {
  version: 1;
  listItem: string;
  title: string;
  link: string;
  location?: string;
  department?: string;
}

export interface SourceSpec {
  type: SourceType;
  /** Human-facing URL of the board or listing page. */
  url: string;
  /** Machine endpoint when the type has one. */
  apiUrl?: string;
  atsSlug?: string;
  /** Secondary identifier (Workday site, Workday host prefix, etc.). */
  atsSite?: string;
  recipe?: HtmlRecipe;
}

export interface FetchInit {
  method?: "GET" | "POST" | "HEAD";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  /**
   * Revalidate this URL even though its body is too large to cache. The fetcher keeps the
   * validators and a hash of the last body it read, sends `If-None-Match`/`If-Modified-Since`, and
   * may answer with `unchanged: true` and an empty body. Only a caller that can produce the listing
   * from somewhere else (the scan, from its last snapshot) may ask for this.
   */
  revalidateLargeBody?: boolean;
}

export interface FetchResponse {
  status: number;
  /** Final URL after redirects. */
  url: string;
  headers: Record<string, string>;
  body: string;
  /**
   * The body was served from the fetcher's cache after a 304: nothing was transferred. Callers
   * that account for bytes must not count this body, or a revalidated scan reads as a full download.
   */
  revalidated?: boolean;
  /**
   * The resource is byte-for-byte what this fetcher last read from it — either the host said so
   * with a 304, in which case `body` is empty, or the body arrived and hashed the same, in which
   * case it is present and only the parse is wasted. Set only for `revalidateLargeBody` requests.
   */
  unchanged?: boolean;
  /** sha1 of the body this URL last served, carried even when the 304 left nothing to hash. */
  contentHash?: string;
}

export interface RenderedPage {
  listingPages?: Array<{ html: string; url: string }>;
  incomplete?: boolean;
  html: string;
  finalUrl: string;
  /** Every request URL the page made while loading; used to sniff ATS APIs. */
  requests: string[];
  status: number | null;
}

/** A binary body, read with the same politeness, caps and timeouts as a text fetch. */
export interface FetchBytesResponse {
  status: number;
  /** Final URL after redirects. */
  url: string;
  headers: Record<string, string>;
  bytes: Uint8Array;
}

export interface FetchContext {
  fetchText(url: string, init?: FetchInit): Promise<FetchResponse>;
  /**
   * Fetch a body as bytes rather than text — an icon, an image. Optional: a context without it
   * simply cannot capture binary assets, and callers that need one say so (`captureCompanyLogo`
   * throws rather than guessing). `maxBodyBytes` is a hard cap, not a truncation point: a body
   * over it is rejected, because half an image is worse than none.
   */
  fetchBytes?(url: string, init?: FetchInit): Promise<FetchBytesResponse>;
  /** Headless-browser render. Optional: when absent, discovery and scanning fall back to plain HTTP. */
  render?: (url: string, opts?: { scrollAndExpand?: boolean }) => Promise<RenderedPage>;
  log?: (msg: string, data?: unknown) => void;
  now?: () => Date;
}

export interface VerifyResult {
  ok: boolean;
  count?: number;
  companyName?: string;
  sample?: RawPosting[];
  error?: string;
}

export interface Adapter {
  type: SourceType;
  /**
   * True when the listing deliberately carries no description and one request per role does
   * (Greenhouse). A scan of such a source never reads descriptions inline: it defers every
   * description-matching gate for the postings that have none and queues the fetches instead,
   * so a 2,000-role board costs one bounded listing request rather than the whole board at once.
   */
  descriptionsPerPosting?: boolean;
  /** Derive a spec from any URL seen on company pages (links, iframes, scripts, network requests). */
  specFromUrl(url: string): SourceSpec | null;
  fetchPostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]>;
  verify(spec: SourceSpec, ctx: FetchContext): Promise<VerifyResult>;
}

/**
 * The listing was read, but the adapter knows it is short: a paging loop hit its page budget with
 * more pages to go, or the feed said it holds more roles than it returned. The postings that were
 * read are carried on the error so the scan can still store them, and the scan records itself as
 * `partial` — the only status that keeps every stored role open. A truncated listing returned as a
 * complete one is what closes roles that were never missing.
 */
export class IncompleteListingError extends Error {
  constructor(
    message: string,
    public readonly postings: RawPosting[],
  ) {
    super(message);
    this.name = "IncompleteListingError";
  }
}

/**
 * `blocked` is bot protection: a 403 or a challenge page, which no retry undoes and whose remedy is
 * manual. `rate_limited` is a 429 or 503 — the host asking us to come back later, which is an
 * ordinary failed fetch that retries on the normal schedule and must never disable a source.
 */
export class SourceFetchError extends Error {
  constructor(
    message: string,
    public readonly kind: "http" | "blocked" | "rate_limited" | "parse" | "timeout" | "network",
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SourceFetchError";
  }
}
