import { createHash } from "node:crypto";
import { z } from "zod";
import { groupCvLibrary, isActiveStoredEvidence, type CvContent, type CvLibrary } from "./cv";
import { CV_SKILL_GUIDANCE, cvSkillIdentity } from "./cv-format";

const shortLabel = z.string().trim().min(1).max(60).refine(value => {
  const words = value.split(/\s+/u);
  return words.length <= CV_SKILL_GUIDANCE.suggestionMaxWords && !/[\r\n\t]/u.test(value) && words.every(word => /[\p{L}\p{N}]/u.test(word));
}, "Use one to three words on one line.");
const categoryLabel = z.string().trim().min(1).max(60);

export const CvSkillSuggestionSchema = z.object({
  id: z.string().uuid(),
  category: categoryLabel,
  label: shortLabel,
  sourceId: z.string().min(1).max(180),
  evidenceQuote: z.string().trim().min(1).max(400),
  roleQuote: z.string().trim().min(1).max(400),
});
export type CvSkillSuggestion = z.infer<typeof CvSkillSuggestionSchema>;
const proposedSkill = CvSkillSuggestionSchema.omit({ id: true });
/** Provider grammar keeps the shape; per-candidate limits and citations are checked later. */
export const CvSkillSuggestionPlanSchema = z.object({ suggestions: z.array(z.object({
  category: z.string(), label: z.string(), sourceId: z.string(), evidenceQuote: z.string(), roleQuote: z.string(),
})).max(CV_SKILL_GUIDANCE.suggestionCandidatePoolLimit) });
const candidateEnvelope = z.object({ suggestions: z.array(z.unknown()).max(CV_SKILL_GUIDANCE.suggestionCandidatePoolLimit) });
export const CvSkillVerificationSchema = z.object({ decisions: z.array(z.object({
  index: z.number().int().min(0).max(CV_SKILL_GUIDANCE.suggestionCandidatePoolLimit - 1), sourceSupports: z.boolean(), roleRelevant: z.boolean(),
})).max(CV_SKILL_GUIDANCE.suggestionCandidatePoolLimit) });

const normal = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-GB");
const contains = (haystack: string, needle: string) => normal(haystack).includes(normal(needle));

/** Only confirmed experience rows, not existing skill labels or the target role, can ground a skill. */
export function cvSkillEvidenceRows(library: CvLibrary): Array<{ id: string; text: string }> {
  if (!library.entries.some(entry => entry.kind === "experience" && isActiveStoredEvidence(entry) && entry.confirmedResponsibilities?.length)) return [];
  try {
    return groupCvLibrary(library).entries.flatMap(entry => entry.kind === "experience"
      ? (entry.confirmedResponsibilities ?? []).map((text, index) => ({ id: `entry:${entry.id}:row:${index}`, text }))
      : []);
  } catch (error) {
    if (error instanceof Error && /Confirm at least one responsibility/.test(error.message)) return [];
    throw error;
  }
}

/** Existing labels are hints for reuse, never evidence of a skill by themselves. */
export function cvReusableSkillRows(library: CvLibrary): Array<{ id: string; category: string; labels: string[] }> {
  return library.entries.flatMap(entry => entry.kind === "skill" && isActiveStoredEvidence(entry) && entry.skillItems?.length
    ? [{ id: entry.id, category: entry.heading, labels: entry.skillItems }] : []);
}

export function cvHighlightedSkillRows(content: CvContent): Array<{ category: string; labels: string[] }> {
  return content.sections.flatMap(section => section.kind === "skill"
    ? [{ category: section.heading, labels: section.skillItems ?? section.bullets }] : []);
}

export function cvSkillSuggestionInputHash(libraryVersion: number, draftId: string, description: string, rows: readonly { id: string; text: string }[],
  highlightedSkills: readonly { category: string; labels: string[] }[]): string {
  return createHash("sha256").update(JSON.stringify({ libraryVersion, draftId, description, rows, highlightedSkills })).digest("hex");
}

/** The model proposes labels; exact source and role citations are checked independently. */
export function groundedCvSkillSuggestions(raw: unknown, rows: readonly { id: string; text: string }[], description: string,
  verification: unknown): CvSkillSuggestion[] {
  const parsed = candidateEnvelope.safeParse(raw);
  const checked = CvSkillVerificationSchema.safeParse(verification);
  if (!parsed.success || !checked.success) return [];
  const counts = new Map<number, number>();
  for (const decision of checked.data.decisions) counts.set(decision.index, (counts.get(decision.index) ?? 0) + 1);
  const approved = new Set(checked.data.decisions.filter(decision => counts.get(decision.index) === 1 && decision.sourceSupports && decision.roleRelevant).map(decision => decision.index));
  const sources = new Map(rows.map(row => [row.id, row.text]));
  const seen = new Set<string>();
  const grounded = parsed.data.suggestions.flatMap((rawCandidate, index) => {
    if (!approved.has(index)) return [];
    const valid = proposedSkill.safeParse(rawCandidate);
    if (!valid.success) return [];
    const candidate = valid.data;
    const evidence = sources.get(candidate.sourceId);
    const key = cvSkillIdentity(candidate.label);
    if (!evidence || seen.has(key) || !contains(evidence, candidate.evidenceQuote) || !contains(description, candidate.roleQuote)) return [];
    seen.add(key);
    return [{ ...candidate, id: crypto.randomUUID() }];
  });
  // Keep the model's ranking within each category, while allowing more than one relevant
  // category into the final highlighted set. Empty/rejected categories never fill a slot.
  const groups = new Map<string, CvSkillSuggestion[]>();
  for (const item of grounded) {
    const key = normal(item.category);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const chosen: CvSkillSuggestion[] = [];
  while (chosen.length < CV_SKILL_GUIDANCE.recommendedHighlightedTotal) {
    let added = false;
    for (const group of groups.values()) {
      const item = group.shift();
      if (item) { chosen.push(item); added = true; }
      if (chosen.length === CV_SKILL_GUIDANCE.recommendedHighlightedTotal) break;
    }
    if (!added) break;
  }
  return chosen;
}
