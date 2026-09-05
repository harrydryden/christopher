import { desc, eq, inArray } from "drizzle-orm";
import { companies, companyProfiles, companySuggestions, type CompanyProfile, type CompanySuggestion } from "@christopher/db/schema";
import { db } from "@/lib/db";

export interface SuggestionRow {
  suggestion: CompanySuggestion;
  profile: CompanyProfile | null;
  similarToNames: string[];
}

async function resolveSuggestionRows(rows: CompanySuggestion[]): Promise<SuggestionRow[]> {
  const profileIds = [...new Set(rows.map((r) => r.profileId).filter((id): id is string => !!id))];
  const similarIds = [...new Set(rows.flatMap((r) => r.similarTo ?? []))];

  const [profiles, similarCompanies] = await Promise.all([
    profileIds.length ? db().select().from(companyProfiles).where(inArray(companyProfiles.id, profileIds)) : Promise.resolve([]),
    similarIds.length ? db().select({ id: companies.id, name: companies.name }).from(companies).where(inArray(companies.id, similarIds)) : Promise.resolve([]),
  ]);

  const profileById = new Map(profiles.map((p) => [p.id, p]));
  const nameById = new Map(similarCompanies.map((c) => [c.id, c.name]));

  return rows.map((suggestion) => ({
    suggestion,
    profile: suggestion.profileId ? (profileById.get(suggestion.profileId) ?? null) : null,
    similarToNames: (suggestion.similarTo ?? []).map((id) => nameById.get(id) ?? id),
  }));
}

export async function listPendingSuggestions(): Promise<SuggestionRow[]> {
  const rows = await db()
    .select()
    .from(companySuggestions)
    .where(eq(companySuggestions.status, "pending"))
    .orderBy(companySuggestions.rank, desc(companySuggestions.createdAt));
  return resolveSuggestionRows(rows);
}

export async function listResolvedSuggestions(limit = 50): Promise<SuggestionRow[]> {
  const rows = await db()
    .select()
    .from(companySuggestions)
    .where(inArray(companySuggestions.status, ["accepted", "rejected", "expired"]))
    .orderBy(desc(companySuggestions.resolvedAt))
    .limit(limit);
  return resolveSuggestionRows(rows);
}

export async function getSuggestion(id: string): Promise<CompanySuggestion | null> {
  const rows = await db().select().from(companySuggestions).where(eq(companySuggestions.id, id)).limit(1);
  return rows[0] ?? null;
}
