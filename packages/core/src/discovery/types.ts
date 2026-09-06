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

export interface DiscoveryAiHooks {
  /** A1: pick the most likely careers links from a harvested list. */
  chooseCareersLinks?: (input: { companyName: string; homepageUrl: string; links: HarvestedLink[] }) => Promise<Array<{ url: string; confidence: number; reason: string }>>;
  /** A2: classify a page as listing / landing / other, optionally proposing the next hop. */
  classifyPage?: (input: { url: string; text: string; links: HarvestedLink[] }) => Promise<{ kind: "listing" | "landing" | "other"; nextHopUrl?: string; confidence: number }>;
}

export interface DiscoveryContext extends FetchContext {
  /** Map any URL seen on company pages to an ATS spec, or null. */
  resolveSpec: (url: string) => SourceSpec | null;
  /** Scan raw HTML/JS text for ATS references (embed snippets, API URLs). */
  findSpecsInText: (text: string, baseUrl?: string) => SourceSpec[];
  /** Verify a spec by fetching from it; returns a sample. */
  verifySpec: (spec: SourceSpec) => Promise<VerifyResult>;
  /** Extract postings from a same-domain HTML listing page (JSON-LD, heuristics). */
  extractFromHtml: (html: string, pageUrl: string) => RawPosting[];
  ai?: DiscoveryAiHooks;
  /** Hard cap on fetches per discovery run. Default 40. */
  maxFetches?: number;
  maxDurationMs?: number;
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
  fetches: number;
  durationMs: number;
}
