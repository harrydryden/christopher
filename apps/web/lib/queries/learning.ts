import { desc, eq, inArray } from "drizzle-orm";
import { companies, decisions, filterSuggestions, preferenceProfiles, tagVocabulary, type FilterSuggestion, type PreferenceProfile } from "@christopher/db/schema";
import { db } from "@/lib/db";
import { extractSuggestionValue } from "@/lib/filterSuggestions";

export async function getPreferenceProfile(version?: number): Promise<PreferenceProfile | null> {
  if (version !== undefined) {
    const rows = await db().select().from(preferenceProfiles).where(eq(preferenceProfiles.version, version)).limit(1);
    return rows[0] ?? null;
  }
  const rows = await db().select().from(preferenceProfiles).orderBy(desc(preferenceProfiles.version)).limit(1);
  return rows[0] ?? null;
}

export async function listProfileVersions(): Promise<Array<{ version: number; generatedAt: Date }>> {
  return db()
    .select({ version: preferenceProfiles.version, generatedAt: preferenceProfiles.generatedAt })
    .from(preferenceProfiles)
    .orderBy(desc(preferenceProfiles.version));
}

export interface Calibration {
  totalDecisions: number;
  highBucket: { n: number; applyRate: number | null };
  lowBucket: { n: number; skipRate: number | null };
  /** How many more decisions (of any score) are needed before 20 total is reached; null once reached. */
  neededForCalibration: number | null;
}

const CALIBRATION_MIN_DECISIONS = 20;
const HIGH_FIT_THRESHOLD = 70;
const LOW_FIT_THRESHOLD = 30;

export async function getCalibration(): Promise<Calibration> {
  const rows = await db()
    .select({ decision: decisions.decision, fitScoreAtDecision: decisions.fitScoreAtDecision })
    .from(decisions)
    .where(eq(decisions.superseded, false));

  const total = rows.length;
  const high = rows.filter((r) => r.fitScoreAtDecision !== null && r.fitScoreAtDecision >= HIGH_FIT_THRESHOLD);
  const low = rows.filter((r) => r.fitScoreAtDecision !== null && r.fitScoreAtDecision < LOW_FIT_THRESHOLD);
  const highApply = high.filter((r) => r.decision === "apply").length;
  const lowSkip = low.filter((r) => r.decision === "skip").length;

  return {
    totalDecisions: total,
    highBucket: { n: high.length, applyRate: high.length ? highApply / high.length : null },
    lowBucket: { n: low.length, skipRate: low.length ? lowSkip / low.length : null },
    neededForCalibration: total < CALIBRATION_MIN_DECISIONS ? CALIBRATION_MIN_DECISIONS - total : null,
  };
}

export async function listPendingFilterSuggestions(): Promise<FilterSuggestion[]> {
  return db().select().from(filterSuggestions).where(eq(filterSuggestions.status, "pending")).orderBy(desc(filterSuggestions.createdAt));
}

export async function getFilterSuggestion(id: string): Promise<FilterSuggestion | null> {
  const rows = await db().select().from(filterSuggestions).where(eq(filterSuggestions.id, id)).limit(1);
  return rows[0] ?? null;
}

export interface FilterSuggestionRow {
  suggestion: FilterSuggestion;
  companyName: string | null;
}

/** Pending filter suggestions, with the target company's name resolved for pause_company ones. */
export async function listPendingFilterSuggestionsResolved(): Promise<FilterSuggestionRow[]> {
  const rows = await listPendingFilterSuggestions();
  const companyIds = [...new Set(rows.map((r) => (extractSuggestionValue(r).kind === "company" ? (extractSuggestionValue(r) as { companyId: string }).companyId : null)).filter((id): id is string => !!id))];
  const companyRows = companyIds.length ? await db().select({ id: companies.id, name: companies.name }).from(companies).where(inArray(companies.id, companyIds)) : [];
  const nameById = new Map(companyRows.map((c) => [c.id, c.name]));
  return rows.map((suggestion) => {
    const extracted = extractSuggestionValue(suggestion);
    return { suggestion, companyName: extracted.kind === "company" ? (nameById.get(extracted.companyId) ?? null) : null };
  });
}

export async function getReasonTagEditor() {
  const [vocabulary, recent] = await Promise.all([
    db().select().from(tagVocabulary).orderBy(tagVocabulary.tag),
    db().select().from(decisions).where(eq(decisions.superseded, false)).orderBy(desc(decisions.createdAt)).limit(20),
  ]);
  return { vocabulary, recent };
}
