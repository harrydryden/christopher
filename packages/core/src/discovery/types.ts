import type { FetchContext, RawPosting, SourceSpec, VerifyResult } from "../types";

export interface HarvestedLink {
  href: string;
  text: string;
  /** Nearby text such as aria-label or parent heading, when available. */
  context?: string;
  rel?: string;
  /** Where the link was found: "a" | "iframe" | "script" | "link" | "meta" | "network" | "sitemap" | "probe". */
  kind: string;
}

/**
 * Who a discovery model call is made for, so its cost is attributed to the account that asked for
 * the company. The hooks receive it as their second argument.
 */
export interface DiscoveryAiRef {
  refType?: string;
  refId?: string;
  userId?: string;
}

export interface DiscoveryAiHooks {
  /** A1: pick the most likely careers links from a harvested list. */
  chooseCareersLinks?: (input: { companyName: string; homepageUrl: string; links: HarvestedLink[] }, ref?: DiscoveryAiRef) => Promise<Array<{ url: string; confidence: number; reason: string }>>;
  /** A2: classify a page as listing / landing / other, optionally proposing the next hop. */
  classifyPage?: (input: { url: string; text: string; links: HarvestedLink[] }, ref?: DiscoveryAiRef) => Promise<{ kind: "listing" | "landing" | "other"; nextHopUrl?: string; confidence: number }>;
}

/** A verification, and whether a failure was the host asking us to come back later. */
export type DiscoveryVerification = VerifyResult & { transient?: boolean };

export interface DiscoveryContext extends FetchContext {
  /** Map any URL seen on company pages to an ATS spec, or null. */
  resolveSpec: (url: string) => SourceSpec | null;
  /** Scan raw HTML/JS text for ATS references (embed snippets, API URLs). */
  findSpecsInText: (text: string, baseUrl?: string) => SourceSpec[];
  /** Verify a spec by reading one page of it; returns a sample and the board's count. */
  verifySpec: (spec: SourceSpec) => Promise<DiscoveryVerification>;
  /** Extract postings from a same-domain HTML listing page (JSON-LD, heuristics). */
  extractFromHtml: (html: string, pageUrl: string) => RawPosting[];
  ai?: DiscoveryAiHooks;
  /** Passed to every model call this run makes. */
  aiRef?: DiscoveryAiRef;
  /** Hard cap on crawl fetches and renders per discovery run. Default 40. Verification is separate. */
  maxFetches?: number;
  /** The crawl's own time budget. Default 120 s. Verification is separate; the task deadline bounds both. */
  maxDurationMs?: number;
  /** Boards one run may verify. Default 10. */
  maxVerifications?: number;
  /** The task's own signal: once it is aborted, the run stops crawling and verifying. */
  signal?: AbortSignal;
}

export interface DiscoveryCandidate {
  spec: SourceSpec;
  confidence: number;
  /** e.g. "ats_link", "ats_network", "ats_script", "ats_guess", "listing_jsonld", "listing_links", "landing", "probe_path", "sitemap", "ai_choice" */
  method: string;
  evidence: string[];
  sample: RawPosting[];
  count?: number;
  companyName?: string;
}

export type DiscoveryOutcome = "resolved" | "needs_confirmation" | "not_found";

export interface DiscoveryResult {
  homepageUrl: string;
  finalHomepageUrl?: string;
  companyName?: string;
  faviconUrl?: string;
  outcome: DiscoveryOutcome;
  best?: DiscoveryCandidate;
  candidates: DiscoveryCandidate[];
  log: string[];
  /** Crawl fetches and renders. */
  fetches: number;
  /** Boards verified. */
  verifications?: number;
  durationMs: number;
  /**
   * Set when the outcome is not to be trusted yet: the best candidate's verification failed because
   * the host asked us to come back later (a 429, a 503, a timeout). The caller retries the discovery
   * rather than recording that nothing was found.
   */
  retry?: string;
}
