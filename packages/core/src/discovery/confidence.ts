import type { DiscoveryCandidate } from "./types";
import { companyNamesMatch } from "./text";

export const AUTO_ACCEPT_CONFIDENCE = 0.85;
export const CONFIRM_CONFIDENCE = 0.5;

/**
 * Every discovery method: `base` is its confidence (SPEC 3.2 step 8), `rank` how a candidate it
 * found is ordered against another found for the same source or at the same confidence. One table,
 * so a method cannot be added to one and silently get rank 0 or confidence 0.4 from the other.
 */
const METHODS = {
  ats_network: { rank: 9, base: 0.97 },
  pasted_ats: { rank: 9, base: 0.95 },
  ats_link: { rank: 8, base: 0.95 },
  ats_script: { rank: 8, base: 0.95 },
  ats_bundle: { rank: 7, base: 0.95 },
  listing_jsonld: { rank: 6, base: 0.85 },
  listing_html: { rank: 6, base: 0.85 },
  listing_empty: { rank: 6, base: 0.85 },
  pasted_listing: { rank: 6, base: 0.85 },
  ai_listing: { rank: 5, base: 0.75 },
  ats_sitemap: { rank: 3, base: 0.7 },
  ats_probe: { rank: 3, base: 0.7 },
  ats_guess: { rank: 3, base: 0.7 },
  landing: { rank: 1, base: 0.5 },
} as const satisfies Record<string, { rank: number; base: number }>;

export type DiscoveryMethod = keyof typeof METHODS;

const methodEntry = (method: string): { rank: number; base: number } | undefined => (METHODS as Record<string, { rank: number; base: number }>)[method];

/** How strongly a method's candidate is preferred; 0 for one outside the table (a verified catalogue board). */
export function methodRank(method: string): number {
  return methodEntry(method)?.rank ?? 0;
}

export interface ConfidenceContext {
  /** Company name taken from the homepage, used to sanity-check a verified feed. */
  homepageCompanyName?: string;
  /** How many distinct methods pointed at this same source. */
  methodCount?: number;
  /**
   * The verified feed names no company, and neither its board slug nor its tenant matches the
   * company's name or domain: the board may be a partner's or a sister company's.
   */
  identityUnconfirmed?: boolean;
}

/** What a mismatched identity costs: enough to take any verified board below auto-accept. */
const IDENTITY_PENALTY = 0.15;

export function confidenceFor(candidate: Pick<DiscoveryCandidate, "method" | "companyName" | "count">, ctx: ConfidenceContext = {}): number {
  let score = methodEntry(candidate.method)?.base ?? 0.4;
  const extraMethods = Math.max(0, (ctx.methodCount ?? 1) - 1);
  score += extraMethods * 0.02;
  if (candidate.companyName && ctx.homepageCompanyName && !companyNamesMatch(candidate.companyName, ctx.homepageCompanyName)) {
    // Several references to the same board must not outvote an explicit identity contradiction.
    score = Math.min(score - IDENTITY_PENALTY, AUTO_ACCEPT_CONFIDENCE - 0.01);
  } else if (!candidate.companyName && ctx.identityUnconfirmed) {
    // However many methods found it, a board nothing ties to the company is for a person to confirm.
    score = Math.min(score - IDENTITY_PENALTY, AUTO_ACCEPT_CONFIDENCE - 0.05);
  }
  return Number(Math.max(0, Math.min(0.99, score)).toFixed(3));
}

export function outcomeFor(best: number | undefined): "resolved" | "needs_confirmation" | "not_found" {
  if (best === undefined) return "not_found";
  if (best >= AUTO_ACCEPT_CONFIDENCE) return "resolved";
  if (best >= CONFIRM_CONFIDENCE) return "needs_confirmation";
  return "not_found";
}
