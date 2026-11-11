import { getCareerRecommendationProfile } from "@col/db";
import { recommendCatalogueRoles } from "@col/db/catalogue-recommendations";
import type { RecommendedCatalogueRole } from "@col/core/catalogue-recommendations";
import { db } from "@/lib/db";
import { getSettingsFor } from "@/lib/settings";
import { hasChosenGate } from "./setup";

export interface CareerCompanyRecommendation {
  companyId: string;
  name: string;
  domain: string;
  following: boolean;
  roles: RecommendedCatalogueRole[];
}
export type CareerRecommendationResult = {
  state: "ready" | "disabled" | "empty_experience" | "unavailable";
  companies: CareerCompanyRecommendation[];
};

export async function careerRecommendations(userId: string): Promise<CareerRecommendationResult> {
  try {
    const [settings, chosen] = await Promise.all([getSettingsFor(userId), hasChosenGate(userId)]);
    if (!settings.suggestionsEnabled) return { state: "disabled", companies: [] };
    const profile = await getCareerRecommendationProfile(db(), userId);
    if (!profile) return { state: "empty_experience", companies: [] };
    // The factory's operations keyword is not a preference the person actually chose.
    const gate = chosen ? settings.gate : { includeKeywords: [], excludeKeywords: [], matchFields: ["title" as const], locationTerms: [], includeRemote: true };
    const matches = await recommendCatalogueRoles(db(), userId, profile, gate);
    const groups = new Map<string, CareerCompanyRecommendation>();
    for (const match of matches) {
      const company = groups.get(match.role.companyId);
      if (company) { if (company.roles.length < 2) company.roles.push(match); continue; }
      if (groups.size < 6) groups.set(match.role.companyId, { companyId: match.role.companyId, name: match.role.companyName, domain: match.role.domain, following: match.role.following, roles: [match] });
    }
    return { state: "ready", companies: [...groups.values()] };
  } catch {
    console.error("Career catalogue recommendations could not be loaded");
    return { state: "unavailable", companies: [] };
  }
}
