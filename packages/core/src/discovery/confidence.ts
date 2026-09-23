import type { DiscoveryCandidate } from "./types";
import { companyNamesMatch } from "./text";

export const AUTO_ACCEPT_CONFIDENCE = 0.85;
export const CONFIRM_CONFIDENCE = 0.5;

/** Base confidence per discovery method, from SPEC 3.2 step 8. */
const BASE: Record<string, number> = {
  ats_network: 0.97,
  ats_link: 0.95,
  ats_script: 0.95,
  ats_bundle: 0.95,
  pasted_ats: 0.95,
  listing_jsonld: 0.85,
  listing_html: 0.85,
  listing_empty: 0.85,
  pasted_listing: 0.85,
  ai_listing: 0.75,
  ats_sitemap: 0.7,
  ats_probe: 0.7,
  ats_guess: 0.7,
  landing: 0.5,
};

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
  let score = BASE[candidate.method] ?? 0.4;
  const extraMethods = Math.max(0, (ctx.methodCount ?? 1) - 1);
  score += extraMethods * 0.02;
  if (candidate.companyName && ctx.homepageCompanyName && !companyNamesMatch(candidate.companyName, ctx.homepageCompanyName)) {
    score -= IDENTITY_PENALTY;
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
