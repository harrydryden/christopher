/** Shared, runtime-agnostic types for scraping, discovery and gating. */

export type SourceType =
  | "greenhouse" | "lever" | "ashby" | "workable" | "smartrecruiters" | "recruitee" | "personio"
  | "bamboohr" | "workday" | "pinpoint" | "breezy" | "jsonld" | "rss" | "html";

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
}

export interface FetchResponse {
  status: number;
  /** Final URL after redirects. */
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface RenderedPage {
  html: string;
  finalUrl: string;
  /** Every request URL the page made while loading; used to sniff ATS APIs. */
  requests: string[];
  status: number | null;
}

export interface FetchContext {
  fetchText(url: string, init?: FetchInit): Promise<FetchResponse>;
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
  /** Derive a spec from any URL seen on company pages (links, iframes, scripts, network requests). */
  specFromUrl(url: string): SourceSpec | null;
  fetchPostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]>;
  verify(spec: SourceSpec, ctx: FetchContext): Promise<VerifyResult>;
}

export class SourceFetchError extends Error {
  constructor(
    message: string,
    public readonly kind: "http" | "blocked" | "parse" | "timeout" | "network",
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SourceFetchError";
  }
}
