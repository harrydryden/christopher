import { cache } from "react";
import { desc, eq, inArray, sql, and, ilike } from "drizzle-orm";
import { companies, companyProfiles, companySuggestions, type CompanyProfile, type CompanySuggestion } from "@ava/db/schema";
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

export async function listPendingSuggestions(userId: string, page = 1, q = ""): Promise<SuggestionRow[]> {
  const rows = await db()
    .select()
    .from(companySuggestions)
    .where(and(eq(companySuggestions.userId, userId), eq(companySuggestions.status, "pending"), suggestionSearch(q)))
    .orderBy(companySuggestions.rank, desc(companySuggestions.createdAt), companySuggestions.id).limit(50).offset((page - 1) * 50);
  return resolveSuggestionRows(rows);
}

export async function listResolvedSuggestions(userId: string, limit = 50, page = 1, q = ""): Promise<SuggestionRow[]> {
  const rows = await db()
    .select()
    .from(companySuggestions)
    .where(and(eq(companySuggestions.userId, userId), inArray(companySuggestions.status, ["accepted", "rejected", "expired"]), suggestionSearch(q)))
    .orderBy(desc(companySuggestions.resolvedAt), companySuggestions.id)
    .limit(limit).offset((page - 1) * limit);
  return resolveSuggestionRows(rows);
}

export async function getSuggestion(userId: string, id: string): Promise<CompanySuggestion | null> {
  const rows = await db().select().from(companySuggestions).where(and(eq(companySuggestions.userId, userId), eq(companySuggestions.id, id))).limit(1);
  return rows[0] ?? null;
}

function suggestionSearch(q: string) {
  return q ? ilike(companySuggestions.name, `%${q.slice(0, 200).replace(/[\\%_]/g, "\\$&")}%`) : undefined;
}
/** Read once per request: the status strip and the Suggestions page both count the pending ones. */
const countSuggestions = cache(async (userId: string, history: boolean, q: string) => {
  const [row] = await db().select({ n: sql<number>`count(*)::int` }).from(companySuggestions)
    .where(and(eq(companySuggestions.userId, userId), history ? inArray(companySuggestions.status, ["accepted", "rejected", "expired"]) : eq(companySuggestions.status, "pending"), suggestionSearch(q)));
  return row?.n ?? 0;
});

export function suggestionCount(userId: string, history = false, q = ""): Promise<number> {
  return countSuggestions(userId, history, q);
}
