import { compileGate, compileTerm, type GateInput, type GateSettings } from "./gate";

/** Private, deliberately small projection. Never pass career narratives or contact fields here. */
export interface CareerRecommendationProfile {
  version: number;
  hash: string;
  roles: string[];
  skills: string[];
  industries: string[];
  terms: string[];
}

export const CATALOGUE_MATCH_VERSION = "career-catalogue-v1";
export const CATALOGUE_FRESH_DAYS = 30;
const GENERIC = new Set("and the for with from into this that role work team senior junior manager director head chief officer vice president consultant associate assistant of to in at on a an".split(" "));

export interface CareerMatchTerm { label: string; kind: "skill" | "role" | "industry" }

/** Stable bounded retrieval vocabulary, not a cap on the stored career record. */
export function careerMatchTerms(profile: CareerRecommendationProfile): CareerMatchTerm[] {
  const terms = new Map<string, CareerMatchTerm>();
  const add = (label: string, kind: CareerMatchTerm["kind"]) => {
    const clean = label.trim().replace(/\s+/g, " ");
    if (clean.length < 2 || clean.length > 100 || GENERIC.has(clean.toLowerCase())) return;
    const key = clean.toLowerCase();
    if (!terms.has(key)) terms.set(key, { label: clean, kind });
  };
  // A named skill is stronger evidence of relevance than the same token from a role title.
  for (const skill of [...profile.skills].sort()) add(skill, "skill");
  for (const role of [...profile.roles].sort()) {
    for (const word of role.match(/[\p{L}\p{N}+#]+/gu) ?? []) if (word.length >= 4) add(word, "role");
  }
  for (const industry of [...profile.industries].sort()) add(industry, "industry");
  return [...terms.values()].slice(0, 120);
}

export interface CatalogueRoleCandidate extends GateInput {
  id: string;
  companyId: string;
  companyName: string;
  domain: string;
  homepageUrl: string;
  url: string | null;
  companyText: string;
  lastSeenAt: Date;
  status: string;
  shared: boolean;
  manualOwnerId: string | null;
  following: boolean;
}

/** Payment deliberately has no field in the organic matching contract. */
export interface OrganicCatalogueMatch {
  kind: "organic";
  algorithm: typeof CATALOGUE_MATCH_VERSION;
  profileVersion: number;
  profileHash: string;
  score: number;
  reasons: CareerMatchTerm[];
}
export interface RecommendedCatalogueRole { role: CatalogueRoleCandidate; match: OrganicCatalogueMatch }

/** A transparent lexical shortlist, not a prediction of hiring success or a percentage fit. */
export function rankCatalogueRoles(
  profile: CareerRecommendationProfile,
  candidates: CatalogueRoleCandidate[],
  gate: GateSettings,
  now = new Date(),
): RecommendedCatalogueRole[] {
  const compiledGate = compileGate(gate);
  const terms = careerMatchTerms(profile).map(term => ({ ...term, pattern: compileTerm(term.label) }));
  const freshAfter = now.getTime() - CATALOGUE_FRESH_DAYS * 86_400_000;
  const seen = new Set<string>();
  return candidates.flatMap<RecommendedCatalogueRole>(role => {
    if (seen.has(role.id) || !role.shared || role.manualOwnerId || role.status !== "open" || role.lastSeenAt.getTime() < freshAfter) return [];
    seen.add(role.id);
    if (!compiledGate.evaluate(role).inTable) return [];
    const text = `${role.title}\n${role.department ?? ""}\n${role.description ?? ""}`;
    const reasons = terms.filter(term => term.pattern?.test(term.kind === "industry" ? role.companyText : text))
      .map(({ label, kind }) => ({ label, kind }));
    // Working in the same industry alone does not establish relevance to a specific vacancy.
    if (!reasons.some(reason => reason.kind !== "industry")) return [];
    const score = reasons.reduce((sum, reason) => sum + (reason.kind === "skill" ? 5 : reason.kind === "role" ? 3 : 1), 0);
    return [{ role, match: { kind: "organic" as const, algorithm: CATALOGUE_MATCH_VERSION, profileVersion: profile.version, profileHash: profile.hash, score, reasons: reasons.slice(0, 5) } }];
  }).sort((a, b) => b.match.score - a.match.score || a.role.companyId.localeCompare(b.role.companyId) || a.role.id.localeCompare(b.role.id));
}
