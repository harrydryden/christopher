/** An unconfirmed answer and a proposed row are never canonical CV evidence. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { cvQuoteIsAnchored } from "./cv-review";
import { employmentHeading, responsibilityRows, setRowFacets, updateResponsibilityRows, type EvidenceFacet } from "./cv-helpers";
import type { CvLibrary } from "./cv";

export const EvidenceDraftPlanSchema = z.object({
  wording: z.string().trim().min(1).max(2000),
  /** Short verbatim passages from the answer that support the proposed wording. */
  quotes: z.array(z.string().trim().min(1).max(600)).min(1).max(5),
});
export type EvidenceDraftPlan = z.infer<typeof EvidenceDraftPlanSchema>;

export interface EvidenceDraftInput {
  question: string;
  answer: string;
  destination: { kind: "employment" | "evidence"; id: string };
  job?: { company: string; title: string; startDate: string; endDate: string; current: boolean } | null;
  baseVersion: number;
  source: "library" | "cv_quiz";
  sourceId?: string | null;
  questionId: string;
  facet?: EvidenceFacet | null;
}

/** Stable across double clicks and tabs; changes to any fact make a separate request. */
export function evidenceDraftFingerprint(input: EvidenceDraftInput): string {
  return createHash("sha256").update(JSON.stringify({
    source: input.source, sourceId: input.sourceId ?? null, questionId: input.questionId,
    destination: input.destination, baseVersion: input.baseVersion,
    question: input.question.trim(), answer: input.answer.trim(), facet: input.facet ?? null,
  })).digest("hex");
}

const numbers = (text: string) => text.match(/(?:£|\$|€)?\b\d+(?:[.,]\d+)?%?/g) ?? [];
const strongOwnership = /\b(?:led|owned|headed|directed|founded|built|created|delivered|managed|launched)\b/gi;
const approximation = /\b(?:around|about|approximately|roughly|circa|nearly|almost|estimated|estimate|up to|at least|more than|over|under|perhaps|maybe)\b/i;
/**
 * The quote, numbers and attribution checks are conservative. They cannot prove that a paraphrase
 * is true, so the person still sees their answer beside the wording and confirms the exact text.
 */
export function validateEvidenceDraft(input: EvidenceDraftInput, raw: unknown): { wording: string; quotes: string[] } | null {
  const parsed = EvidenceDraftPlanSchema.safeParse(raw);
  if (!parsed.success) return null;
  const wording = parsed.data.wording.replace(/\s+/g, " ").trim();
  const quotes = parsed.data.quotes;
  if (!quotes.every(quote => cvQuoteIsAnchored(quote, input.answer))) return null;
  const source = `${input.answer} ${input.job?.company ?? ""} ${input.job?.title ?? ""} ${input.job?.startDate ?? ""} ${input.job?.endDate ?? ""}`;
  const sourceNumbers = new Set(numbers(source));
  if (numbers(wording).some(number => !sourceNumbers.has(number))) return null;
  // A precise claim cannot be made from an approximate answer merely because the digits match.
  if (numbers(wording).length && approximation.test(input.answer) && !approximation.test(wording)) return null;
  const answerVerbs = new Set((input.answer.match(strongOwnership) ?? []).map(verb => verb.toLowerCase()));
  const proposedVerbs = (wording.match(strongOwnership) ?? []).map(verb => verb.toLowerCase());
  if (proposedVerbs.some(verb => !answerVerbs.has(verb))) return null;
  // A person's "we" cannot become solitary ownership. First-person wording remains editable.
  if (/\bwe\b/i.test(input.answer) && !/\bI\b/i.test(input.answer) &&
      (/^I\s/i.test(wording) || /^(?:led|owned|headed|directed|founded|built|created|delivered|managed|launched)\b/i.test(wording))) return null;
  if (/\b(?:helped|supported|assisted|contributed to)\b/i.test(input.answer) &&
      /^(?:I\s+)?(?:led|owned|headed|directed|founded|built|created|delivered|managed|launched)\b/i.test(wording) &&
      !/\bI\s+(?:led|owned|headed|directed|founded|built|created|delivered|managed|launched)\b/i.test(input.answer)) return null;
  return { wording, quotes };
}

/** Put only the exact wording a person affirmed into the existing Library row model. */
export function appendConfirmedEvidence(library: CvLibrary, input: EvidenceDraftInput, wording: string, newId: string): CvLibrary {
  const row = wording.trim();
  if (!row || row.length > 2000 || row.includes("\n")) throw new Error("Add one concise evidence row before saving.");
  if (input.destination.kind === "employment") {
    const job = library.employment?.find(item => item.id === input.destination.id);
    if (!job) throw new Error("That job is no longer in Experience.");
    const existing = library.entries.find(item => item.kind === "experience" && item.employmentId === job.id);
    if (existing?.status === "inactive") throw new Error("Restore this job before adding evidence to it.");
    const rows = existing ? responsibilityRows(existing.details) : [];
    if (rows.includes(row)) throw new Error("This wording is already in Experience.");
    if (rows.length >= 20) throw new Error("This job already has 20 evidence rows. Combine two rows before adding another.");
    if (existing) {
      const updated = updateResponsibilityRows(existing, [...rows, row]);
      const tagged = input.facet ? setRowFacets(updated, row, [input.facet]) : updated;
      return { ...library, entries: library.entries.map(item => item.id === existing.id
        ? { ...tagged, confirmedResponsibilities: [...(tagged.confirmedResponsibilities ?? []), row] } : item) };
    }
    const entry = {
      id: newId, kind: "experience" as const, status: "active" as const, employmentId: job.id,
      heading: employmentHeading(job) || job.company || job.jobTitle,
      details: row, confirmedResponsibilities: [row],
      ...(input.facet ? { rowFacets: { [row]: [input.facet] } } : {}),
    };
    return { ...library, entries: [...library.entries, entry] };
  }
  const existing = library.entries.find(item => item.id === input.destination.id && item.status !== "inactive");
  if (!existing) throw new Error("That evidence block is no longer in Experience.");
  if (existing.kind === "experience") throw new Error("Choose its job as the destination for experience evidence.");
  const rows = responsibilityRows(existing.details);
  if (rows.includes(row)) throw new Error("This wording is already in Experience.");
  return { ...library, entries: library.entries.map(item => item.id === existing.id ? { ...item, details: `${item.details}\n${row}` } : item) };
}
