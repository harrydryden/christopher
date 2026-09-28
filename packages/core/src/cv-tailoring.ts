import { z } from "zod";
import { cvRequirementWeight, RequirementStatusSchema, type CvRubric } from "./cv-assessment";
import type { CvLibrary, CvPlan } from "./cv";
import { evidenceRows } from "./cv-helpers";
import type { CvGapQuestion } from "./cv-gap-quiz";
import { mentionsDemographicAttribute } from "./cv-demographics";
// A function declaration, read only when a plan is validated: safe across the cv-budget cycle.
import { cvRelevance } from "./cv-budget";

// The evidence plan's citation. Written here rather than built from ./cv: ./cv re-exports
// ./cv-budget, which imports this module, so a value read from ./cv here is not yet initialised.
export const CvTailoringSourceRefSchema = z.object({ sourceId: z.string().min(1).max(220), quote: z.string().trim().min(1).max(1600) });
export type CvTailoringSourceRef = z.infer<typeof CvTailoringSourceRefSchema>;

export const CvTailoringPlanSchema = z.object({
  requirements: z.array(z.object({
    requirementId: z.string().min(1).max(40),
    status: RequirementStatusSchema,
    evidence: z.array(CvTailoringSourceRefSchema).max(8),
    reason: z.string().trim().min(1).max(700),
  })).min(1).max(30),
  // Kept structurally identical to CvGapQuestion; a plain union also converts cleanly to the
  // provider's JSON Schema (some converters cannot traverse a nested discriminated union).
  gapQuestions: z.array(z.object({
    id: z.string().min(1).max(80),
    requirementId: z.string().min(1).max(40),
    requirement: z.string().trim().min(1).max(250),
    prompt: z.string().trim().min(1).max(500),
    suggestedDestination: z.union([
      z.object({ kind: z.literal("employment"), employmentId: z.string().min(1).max(100) }),
      z.object({ kind: z.literal("evidence"), entryId: z.string().min(1).max(100) }),
    ]),
  }) satisfies z.ZodType<CvGapQuestion>).max(4),
});
export type CvTailoringPlan = z.infer<typeof CvTailoringPlanSchema>;

/**
 * The planner's answer. Its reasons are read by nobody downstream — the writer gets the plan
 * without them (`cvTailoringPlanForWriter`) — so the prompt asks for one clause of at most 160
 * characters. The schema's ceiling is 300, not 160: the length is only a hint in the output
 * grammar, and a reason a few characters over it should not discard a paid plan. A stored plan
 * is read with `CvTailoringPlanSchema`, which still accepts the longer reasons older plans carry.
 */
export const CvTailoringPlanOutputSchema = CvTailoringPlanSchema.extend({
  requirements: z.array(CvTailoringPlanSchema.shape.requirements.element.extend({
    reason: z.string().trim().min(1).max(300),
  })).min(1).max(30),
});

/** What the writer is given of the plan: the verdict and the rows it rests on, by id. */
export type CvTailoringPlanForWriter = {
  requirements: Array<{ requirementId: string; status: CvTailoringPlan["requirements"][number]["status"]; evidence: string[] }>;
};

/**
 * The plan as the writer's role block embeds it: each requirement's status and the ids of the rows
 * that evidence it. The reasons and the quotes are left out — the writer has every row, by id, in
 * the library block, and nothing it writes depends on why the planner judged as it did.
 */
export function cvTailoringPlanForWriter(plan: CvTailoringPlan): CvTailoringPlanForWriter {
  return { requirements: plan.requirements.map(item => ({
    requirementId: item.requirementId, status: item.status, evidence: item.evidence.map(reference => reference.sourceId),
  })) };
}
export type CvTailoringEvidenceItem = { id: string; text: string; entryId?: string; row?: number };

/** Give the planner addressable rows, rather than forcing it to cite an entire role block. */
export function cvTailoringEvidence(library: CvLibrary): CvTailoringEvidenceItem[] {
  return [
    ...(library.profile.trim() ? [{ id: "source:profile", text: library.profile }] : []),
    // Archived evidence only: a block is active by belonging to a job the person still lists, and
    // the draft a release before this one could write reads as active.
    ...library.entries.filter(entry => entry.status !== "inactive").flatMap(entry => [
      ...evidenceRows(entry).filter(text => entry.kind !== "experience" || (entry.confirmedResponsibilities ?? []).includes(text))
        .map((text, row) => ({ id: `entry:${entry.id}:row:${row}`, text, entryId: entry.id, row })),
      ...(entry.skillItems ?? []).map((text, row) => ({ id: `entry:${entry.id}:skill:${row}`, text, entryId: entry.id, row })),
    ]),
  ];
}

const normaliseQuote = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-GB");
const quoteExists = (quote: string, source: string) => normaliseQuote(source).includes(normaliseQuote(quote));

/**
 * Treat the model's pre-writing plan as an index over trusted inputs, never as evidence itself.
 * Returns canonical source quotes so later prompts cannot inherit altered or injected source IDs.
 */
export function validateCvTailoringPlan(
  value: unknown,
  rubric: CvRubric,
  sources: readonly CvTailoringEvidenceItem[],
  library?: CvLibrary,
): CvTailoringPlan {
  const plan = CvTailoringPlanSchema.parse(value);
  const requirements = new Map(rubric.requirements.map(requirement => [requirement.id, requirement]));
  const sourceById = new Map(sources.map(source => [source.id, source]));
  if (sourceById.size !== sources.length) throw new Error("Tailoring evidence source IDs must be unique.");
  if (plan.requirements.length !== rubric.requirements.length || new Set(plan.requirements.map(item => item.requirementId)).size !== plan.requirements.length ||
      plan.requirements.some(item => !requirements.has(item.requirementId)) || rubric.requirements.some(requirement => !plan.requirements.some(item => item.requirementId === requirement.id))) {
    throw new Error("The tailoring plan must cover every fixed requirement exactly once.");
  }
  const checked = plan.requirements.map(item => {
    if ((item.status === "demonstrated" || item.status === "partial") && !item.evidence.length)
      throw new Error(`${item.requirementId} has a positive status without evidence.`);
    if ((item.status === "missing" || item.status === "unknown") && item.evidence.length)
      throw new Error(`${item.requirementId} cites evidence despite having no supported match.`);
    const evidence = item.evidence.map(reference => {
      const source = sourceById.get(reference.sourceId);
      if (!source) throw new Error(`Unknown tailoring evidence source: ${reference.sourceId}`);
      if (!quoteExists(reference.quote, source.text)) throw new Error(`Tailoring evidence quote is not present in ${reference.sourceId}.`);
      return { sourceId: source.id, quote: reference.quote.trim().replace(/\s+/g, " ") };
    });
    return { ...item, evidence };
  });
  const byRequirement = new Map(checked.map(item => [item.requirementId, item]));
  const hasImportantNonLogistics = rubric.requirements.some(item => item.category !== "logistics" && item.importance !== "responsibility");
  const seenQuestions = new Set<string>();
  const gapQuestions = plan.gapQuestions.filter(question => {
    const requirement = requirements.get(question.requirementId);
    const match = byRequirement.get(question.requirementId);
    if (!requirement || !match || requirement.label !== question.requirement)
      throw new Error("A gap question refers to an unknown requirement.");
    if (!["missing", "partial"].includes(match.status) || requirement.category === "logistics" || (requirement.importance === "responsibility" && hasImportantNonLogistics))
      throw new Error("Gap questions may address only missing or partial important requirements.");
    if (mentionsDemographicAttribute(question.prompt)) throw new Error("Gap questions cannot ask about demographic attributes.");
    if (!question.prompt.endsWith("?") || /^(?:you|your)\b[^?]*[,.;:]/i.test(question.prompt))
      throw new Error("Gap questions must be neutral questions, without a leading invented assertion.");
    if (library) {
      const destination = question.suggestedDestination;
      const exists = destination.kind === "employment"
        ? (library.employment ?? []).some(job => job.id === destination.employmentId)
        : library.entries.some(entry => entry.id === destination.entryId);
      if (!exists) throw new Error("A gap question refers to an unknown Library destination.");
    }
    const key = normaliseQuote(question.prompt);
    if (seenQuestions.has(key)) return false;
    seenQuestions.add(key);
    return true;
  });
  return { requirements: checked, gapQuestions };
}

export function cvTailoringRequirementWeights(plan: CvTailoringPlan, rubric: CvRubric): Map<string, number> {
  const rubricById = new Map(rubric.requirements.map(requirement => [requirement.id, requirement]));
  return new Map(plan.requirements.map(item => [item.requirementId, cvRequirementWeight(rubricById.get(item.requirementId)!)]));
}

/** Requirement IDs supported by each exact evidence row, for coverage-aware fitting. */
export function cvTailoringCoverage(plan: CvTailoringPlan): Map<string, Set<string>> {
  const coverage = new Map<string, Set<string>>();
  for (const requirement of plan.requirements) for (const evidence of requirement.evidence) {
    const ids = coverage.get(evidence.sourceId) ?? new Set<string>();
    ids.add(requirement.requirementId);
    coverage.set(evidence.sourceId, ids);
  }
  return coverage;
}

/**
 * How many content words a bullet must share with the rows it cites, at most: two, or all of the
 * bullet's own when it has fewer (a one-word skill label). Words are `cvRelevance`'s: lower-cased,
 * de-duplicated, with the fitter's stop words (articles, "team", "experience" and the like) left out.
 * Two catches a bullet citing the wrong row — which shares at most incidental words with it —
 * while a faithful rephrasing keeps the row's nouns: "Coached six managers" becomes "Helped six
 * managers grow as leaders". Whether each clause is supported is the audit's question, not this one.
 */
export const CV_PROVENANCE_MIN_SHARED_WORDS = 2;

/** Validate provenance from a newly planned author call; legacy plans deliberately skip this gate. */
export function validateCvPlanProvenance(plan: CvPlan, library: CvLibrary): CvPlan {
  const sources = cvTailoringEvidence(library);
  const sourceById = new Map(sources.map(source => [source.id, source]));
  const cited = (sourceIds: readonly string[], entryId?: string) => sourceIds.map(sourceId => {
    const source = sourceById.get(sourceId);
    if (!source) throw new Error(`Unknown CV source: ${sourceId}`);
    if (entryId && source.entryId !== entryId) throw new Error(`A bullet for ${entryId} cites evidence from another entry.`);
    return source;
  });
  const overlaps = (text: string, rows: readonly CvTailoringEvidenceItem[], where: string) => {
    const own = cvRelevance(text, text);
    const shared = cvRelevance(text, rows.map(row => row.text).join("\n"));
    if (shared < Math.min(CV_PROVENANCE_MIN_SHARED_WORDS, own))
      throw new Error(`${where} shares too few words with the source rows it cites (${rows.map(row => row.id).join(", ")}); cite the rows it rests on.`);
  };
  if (!plan.summarySources?.length) throw new Error("The tailored profile has no source provenance.");
  overlaps(plan.summary, cited(plan.summarySources), "The profile");
  for (const section of plan.sections) {
    if (!section.bulletSources || section.bulletSources.length !== section.bullets.length)
      throw new Error(`Every bullet for ${section.entryId} needs source provenance.`);
    section.bulletSources.forEach((sourceIds, index) =>
      overlaps(section.bullets[index]!, cited(sourceIds, section.entryId), `Bullet ${index + 1} for ${section.entryId}`));
  }
  return plan;
}
