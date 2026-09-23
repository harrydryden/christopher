import { materialiseCv, type CvContent, type CvLibrary, type CvPlan } from "./cv";
import {
  type CvRelevanceTarget,
  createCvWritingBudget,
  cvBudgetViolations,
  cvRelevance,
  type CvSemanticTarget,
  type CvWritingBudget,
} from "./cv-budget";
import { cvTailoringCoverage, cvTailoringRequirementWeights } from "./cv-tailoring";
import { renderCvPdfWithReport, CvLayoutError } from "./cv-pdf";
import { cvMaxPages } from "./cv-theme";
import type { CvBuildFailure, CvFailureKind } from "./cv-build";

export type CvFitFeedback = {
  pageCount: number;
  maxPages: number;
  previousPlan: CvPlan;
  corrections: string[];
};
export type CvFitInput = {
  writingBudget: CvWritingBudget;
  maxPages: number;
  layoutFeedback?: CvFitFeedback;
};

/**
 * Why fitting gave up, in the taxonomy the whole build is classified by.
 *
 * The three ways this can end are three different conversations: the writer dropped evidence it
 * was told to keep, it kept answering in the wrong shape, or the content genuinely does not fit
 * the page limit. They used to be three names of their own, which the worker translated into the
 * build's failure kinds by hand; the fitter now names them in the one taxonomy, so its failures
 * pass through without a second vocabulary to keep in step. `policy` carries the one case where
 * repetition changes hands: three attempts inside this build have already been spent on the skill
 * format, so a fourth from a fresh task would meet the same model and the same library.
 */
export class CvFitFailure extends Error {
  constructor(
    readonly kind: CvFailureKind,
    message: string,
    readonly detail: { omitted?: string[]; corrections?: number; pages?: number; maxPages?: number; attempts?: number } = {},
    readonly policy: Partial<Pick<CvBuildFailure, "resolvedBy" | "retryable" | "action">> = {},
  ) {
    super(message);
    this.name = "CvFitFailure";
  }
}

/**
 * One motion of a build's writing and fitting, for a caller that narrates it.
 *
 * Writing is up to three attempts against shrinking budgets, each measured and trimmed, and a
 * watcher told only "writing" then "fitting" could not say which attempt it was on, what the
 * budget had shrunk to, or what the trimming removed. Each motion says so for itself.
 */
export type CvFitEvent =
  | { motion: "write"; phase: "start"; attempt: number; budgetCharacters: number; budgetScale: number; maxPages: number }
  | { motion: "write"; phase: "done"; attempt: number; roles: number; bullets: number; characters: number }
  | { motion: "check_plan"; attempt: number; omitted: string[]; skillFormatCorrections: number }
  | { motion: "measure"; attempt: number; pages: number; maxPages: number }
  | { motion: "shorten"; attempt: number; removed: number; pages: number; changes: string[] };

/**
 * What the fitter tells its caller: one event per motion, and nothing else.
 *
 * It used to emit the two coarse stage names beside the motions, for a caller written before the
 * motions existed. There is one caller, it reads the motions, and the stage a motion belongs to is
 * already in the motion catalogue — so the caller derives the milestone from the motion rather
 * than being told twice, and the two cannot drift apart.
 */
export type CvFitSignal = CvFitEvent;

function sourceRequirements(sources: { sourceId: string }[] | undefined, semantic?: CvSemanticTarget): Set<string> {
  const found = new Set<string>();
  if (!semantic) return found;
  const coverage = cvTailoringCoverage(semantic.plan);
  for (const source of sources ?? []) coverage.get(source.sourceId)?.forEach(id => found.add(id));
  return found;
}

function valueRequirements(section: CvPlan["sections"][number], index: number, semantic: CvSemanticTarget | undefined, library: CvLibrary): Set<string> {
  if (!section.skillItems) return sourceRequirements(section.bulletSources?.[index], semantic);
  const entry = library.entries.find(item => item.id === section.entryId);
  const sourceIndex = entry?.skillItems?.findIndex(item => item === section.skillItems?.[index]) ?? -1;
  return sourceIndex < 0 ? new Set() : sourceRequirements([{ sourceId: `entry:${section.entryId}:skill:${sourceIndex}` }], semantic);
}

const essentialIds = (semantic?: CvSemanticTarget) => new Set(semantic?.rubric.requirements
  .filter(requirement => requirement.importance === "essential").map(requirement => requirement.id) ?? []);

/** Greedy set coverage protects distinct requirements; a duplicate claim adds no semantic value. */
function selectBulletIndexes(section: CvPlan["sections"][number], limit: number, target: CvRelevanceTarget, semantic: CvSemanticTarget | undefined, library: CvLibrary): Set<number> {
  if (!semantic || !section.bulletSources) return new Set(section.bullets.map((text, index) => ({ index, score: cvRelevance(text, target) + 1 / (index + 1) }))
    .sort((a, b) => b.score - a.score).slice(0, limit).map(item => item.index));
  const weights = cvTailoringRequirementWeights(semantic.plan, semantic.rubric);
  const essential = essentialIds(semantic);
  // Preserve at least one carrier for every represented essential requirement. Protecting only a
  // globally unique carrier is insufficient: two duplicates can both be trimmed while another
  // essential's unique carrier consumes the nominal one-bullet budget.
  const representedEssential = new Set(section.bullets.flatMap((_, index) =>
    [...valueRequirements(section, index, semantic, library)].filter(id => essential.has(id))));
  const selected = new Set<number>();
  const covered = new Set<string>();
  while ([...representedEssential].some(id => !covered.has(id))) {
    const carrier = section.bullets.map((_, index) => ({ index, ids: valueRequirements(section, index, semantic, library) }))
      .filter(item => !selected.has(item.index))
      .map(item => ({ ...item, gain: [...item.ids].filter(id => representedEssential.has(id) && !covered.has(id)).length }))
      .sort((a, b) => b.gain - a.gain || a.index - b.index)[0];
    if (!carrier || !carrier.gain) break;
    selected.add(carrier.index);
    carrier.ids.forEach(id => covered.add(id));
  }
  while (selected.size < Math.min(limit, section.bullets.length)) {
    const candidate = section.bullets.map((_, index) => ({ index, ids: sourceRequirements(section.bulletSources?.[index], semantic) }))
      .filter(item => !selected.has(item.index))
      .map(item => ({ ...item, score: [...item.ids].filter(id => !covered.has(id)).reduce((sum, id) => sum + (weights.get(id) ?? 0), 0) + 1 / (item.index + 1) }))
      .sort((a, b) => b.score - a.score)[0];
    if (!candidate) break;
    selected.add(candidate.index);
    candidate.ids.forEach(id => covered.add(id));
  }
  return selected;
}

function requirementCounts(plan: CvPlan, semantic: CvSemanticTarget | undefined, library: CvLibrary): Map<string, number> {
  const counts = new Map<string, number>();
  if (!semantic) return counts;
  for (const section of plan.sections) {
    const values = section.skillItems ?? section.bullets;
    for (const [index] of values.entries()) for (const id of valueRequirements(section, index, semantic, library))
      counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function semanticRemovalCost(section: CvPlan["sections"][number], index: number, semantic: CvSemanticTarget | undefined, counts: Map<string, number>, library: CvLibrary): number {
  if (!semantic) return 0;
  const weights = cvTailoringRequirementWeights(semantic.plan, semantic.rubric);
  return [...valueRequirements(section, index, semantic, library)]
    .filter(id => counts.get(id) === 1).reduce((sum, id) => sum + (weights.get(id) ?? 0) * 10, 0);
}

/** Remove complete, lower-priority achievements; never truncate a claim or shrink fonts. */
export async function selectCvToFit(
  library: CvLibrary,
  source: CvPlan,
  target: CvRelevanceTarget,
  budget: CvWritingBudget,
  semantic?: CvSemanticTarget,
) {
  const plan = structuredClone(source);
  const changes: string[] = [];
  const semanticOverflows: string[] = [];
  const maxPages = cvMaxPages(library.theme);
  const essential = essentialIds(semantic);
  const essentialSections = new Map<string, Set<string>>();
  if (semantic) for (const section of plan.sections) {
    const values = section.skillItems ?? section.bullets;
    for (const [index] of values.entries()) for (const id of valueRequirements(section, index, semantic, library)) {
      if (!essential.has(id)) continue;
      const sections = essentialSections.get(id) ?? new Set<string>();
      sections.add(section.entryId); essentialSections.set(id, sections);
    }
  }
  plan.sections = plan.sections.filter((section) => {
    if (budget.blocks.some((block) => block.entryId === section.entryId))
      return true;
    const entry = library.entries.find((entry) => entry.id === section.entryId);
    if (entry?.kind === "experience" || entry?.kind === "education")
      return true;
    const soleEssentialBlock = [...essentialSections.values()].some(sections => sections.size === 1 && sections.has(section.entryId));
    if (soleEssentialBlock) {
      semanticOverflows.push(`${section.entryId}: retain this optional block because it is the only source for an essential requirement.`);
      return true;
    }
    changes.push(
      `${entry?.heading ?? section.entryId}: omitted optional block to reserve space for experience and qualifications.`,
    );
    return false;
  });
  // Keep chronological sections, but use relevance to select their strongest bullets.
  for (const section of plan.sections) {
    const block = budget.blocks.find(
      (block) => block.entryId === section.entryId,
    );
    if (
      block?.kind === "skill" &&
      section.skillItems &&
      section.skillItems.length > block.maxSkills
    ) {
      const weights = semantic ? cvTailoringRequirementWeights(semantic.plan, semantic.rubric) : new Map<string, number>();
      const essential = essentialIds(semantic);
      const represented = new Set(section.skillItems.flatMap((_, index) =>
        [...valueRequirements(section, index, semantic, library)].filter(id => essential.has(id))));
      const protectedIndexes = new Set<number>();
      const protectedRequirements = new Set<string>();
      while ([...represented].some(id => !protectedRequirements.has(id))) {
        const carrier = section.skillItems.map((_, index) => ({ index, ids: valueRequirements(section, index, semantic, library) }))
          .filter(item => !protectedIndexes.has(item.index))
          .map(item => ({ ...item, gain: [...item.ids].filter(id => represented.has(id) && !protectedRequirements.has(id)).length }))
          .sort((a, b) => b.gain - a.gain || a.index - b.index)[0];
        if (!carrier || !carrier.gain) break;
        protectedIndexes.add(carrier.index); carrier.ids.forEach(id => protectedRequirements.add(id));
      }
      const ranked = section.skillItems.map((text, index) => ({ index,
        score: semantic ? [...valueRequirements(section, index, semantic, library)].reduce((sum, id) => sum + (weights.get(id) ?? 0), 0) + 1 / (index + 1) : cvRelevance(text, target) + 1 / (index + 1),
      }));
      const selected = new Set(
        [...ranked.filter(item => protectedIndexes.has(item.index)), ...ranked.filter(item => !protectedIndexes.has(item.index))
          .sort((a, b) => b.score - a.score)
          .slice(0, Math.max(0, block.maxSkills - protectedIndexes.size))]
          .map((item) => item.index),
      );
      if (selected.size > block.maxSkills) semanticOverflows.push(`${section.entryId}: consolidate skills without removing sole evidence for an essential requirement.`);
      section.skillItems = section.skillItems.filter((_, index) =>
        selected.has(index),
      );
      changes.push(
        `${library.entries.find((entry) => entry.id === section.entryId)!.heading}: prioritised ${section.skillItems.length} relevant skills.`,
      );
    }
    if (
      block?.kind === "experience" &&
      section.bullets.length > block.maxBullets
    ) {
      const selected = selectBulletIndexes(section, block.maxBullets, target, semantic, library);
      if (selected.size > block.maxBullets) semanticOverflows.push(`${section.entryId}: consolidate achievements without removing sole evidence for an essential requirement.`);
      section.bullets = section.bullets.filter((_, index) =>
        selected.has(index),
      );
      if (section.bulletSources) section.bulletSources = section.bulletSources.filter((_, index) => selected.has(index));
      changes.push(
        `${library.entries.find((entry) => entry.id === section.entryId)!.heading}: prioritised ${section.bullets.length} achievements.`,
      );
    }
  }
  // Which bullet goes next is decided by the plan alone, never by a measurement, so every plan the
  // trimming could reach is known before anything is rendered: the first is the plan as selected,
  // and each after it has one more lower-priority item removed. The fewest removals that fit are
  // then found by bisection, which renders a handful of those plans rather than one per bullet.
  const reachable: Array<{ plan: CvPlan; changes: string[] }> = [{ plan, changes }];
  for (;;) {
    const previous = reachable.at(-1)!;
    const next = structuredClone(previous.plan);
    // Education is protected. Every employment entry retains at least one bullet.
    const semanticCounts = requirementCounts(next, semantic, library);
    const candidates = next.sections
      .flatMap((section, sectionIndex) => {
        const entry = library.entries.find(
          (entry) => entry.id === section.entryId,
        )!;
        if (entry.kind === "education") return [];
        const values = section.skillItems ?? section.bullets;
        return values.flatMap((value, index) =>
          entry.kind === "experience" && values.length === 1
            ? []
            : [
                {
                  sectionIndex,
                  index,
                  score:
                    semanticRemovalCost(section, index, semantic, semanticCounts, library) +
                    (semantic ? 0 : cvRelevance(value, target)) +
                    (entry.kind === "experience" ? 2 : 0) +
                    1 / (sectionIndex + 1) +
                    1 / (index + 1),
                },
              ],
        );
      })
      .filter(candidate => {
        if (!semantic) return true;
        const ids = valueRequirements(next.sections[candidate.sectionIndex]!, candidate.index, semantic, library);
        const essential = essentialIds(semantic);
        return ![...ids].some(id => essential.has(id) && semanticCounts.get(id) === 1);
      }).sort((a, b) => a.score - b.score);
    const remove = candidates[0];
    if (!remove) break;
    const section = next.sections[remove.sectionIndex]!;
    const values = section.skillItems ?? section.bullets;
    values.splice(remove.index, 1);
    if (!section.skillItems && section.bulletSources) section.bulletSources.splice(remove.index, 1);
    const note = `${library.entries.find((entry) => entry.id === section.entryId)!.heading}: omitted a lower-priority ${section.skillItems ? "skill" : "bullet"} to fit.`;
    if (!values.length) next.sections.splice(remove.sectionIndex, 1);
    reachable.push({ plan: next, changes: [...previous.changes, note] });
  }
  const measured = new Map<number, { content: CvContent; pageCount: number }>();
  const measure = async (index: number) => {
    const known = measured.get(index);
    if (known) return known;
    const content = materialiseCv(library, reachable[index]!.plan);
    const { pageCount } = await renderCvPdfWithReport(content);
    const result = { content, pageCount };
    measured.set(index, result);
    return result;
  };
  const selected = async (index: number) => {
    const { content, pageCount } = await measure(index);
    const chosen = reachable[index]!;
    const notes = pageCount <= maxPages && semanticOverflows.length
      ? [...chosen.changes, "Retained distinct essential evidence because the measured PDF still fits the page limit."]
      : chosen.changes;
    return { plan: chosen.plan, content, pageCount, changes: notes, semanticOverflows };
  };
  if ((await measure(0)).pageCount <= maxPages) return selected(0);
  // Removing content never lengthens the document, so the plans that fit are a run at the end.
  let low = 1;
  let high = reachable.length - 1;
  let fits = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((await measure(middle)).pageCount <= maxPages) {
      fits = middle;
      high = middle - 1;
    } else low = middle + 1;
  }
  // Nothing left to remove and still too long: the caller decides what to do with the last plan.
  return selected(fits < 0 ? reachable.length - 1 : fits);
}

/** How much of a plan reached the page: what the narrative reports a writing attempt produced. */
function planSize(plan: CvPlan, budget: CvWritingBudget) {
  const values = plan.sections.flatMap(section => section.skillItems ?? section.bullets);
  return {
    roles: plan.sections.filter(section =>
      budget.blocks.some(block => block.entryId === section.entryId && block.kind === "experience")).length,
    bullets: values.length,
    characters: plan.summary.length + values.reduce((sum, value) => sum + value.length, 0),
  };
}

/**
 * Bounded writing and measured selection, shared by fresh generation and draft fitting.
 *
 * `onEvent` receives one event per motion — each writing attempt with the budget it was given,
 * the reading of what the writer returned, each measurement and each trim — and nothing else. The
 * milestone a motion belongs to is the motion catalogue's to say, so the caller reads it there.
 */
export async function buildFittedCv(
  library: CvLibrary,
  target: CvRelevanceTarget,
  write: (input: CvFitInput) => Promise<CvPlan>,
  initial?: CvPlan,
  onEvent?: (event: CvFitSignal) => void | Promise<void>,
  semantic?: CvSemanticTarget,
) {
  const maxPages = cvMaxPages(library.theme);
  const say = async (event: CvFitSignal) => { await onEvent?.(event); };
  let feedback: CvFitFeedback | undefined;
  let invalidSkillFormat = false;
  let semanticOverflow = false;
  if (initial) {
    const content = materialiseCv(library, initial);
    const report = await renderCvPdfWithReport(content).catch((error) => {
      if (error instanceof CvLayoutError)
        return { pageCount: maxPages + 1 };
      throw error;
    });
    feedback = {
      pageCount: report.pageCount,
      maxPages,
      previousPlan: initial,
      corrections: [
        "Refit this saved wording to the supplied block budgets. Preserve qualifications and employment history.",
      ],
    };
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const budget = createCvWritingBudget(
      library,
      target,
      Math.pow(0.76, attempt),
      semantic,
    );
    // Corrections describe the budget the next attempt will be given, not the one just missed:
    // measured against the current one, a block that fitted it drew no correction at all, and the
    // ones that did quoted figures a quarter larger than the writer's next allocation.
    const next = () => createCvWritingBudget(library, target, Math.pow(0.76, attempt + 1), semantic);
    await say({ motion: "write", phase: "start", attempt: attempt + 1, budgetCharacters: budget.totalCharacters,
      budgetScale: Number(Math.pow(0.76, attempt).toFixed(4)), maxPages });
    const plan = await write({
      writingBudget: budget,
      maxPages,
      ...(feedback ? { layoutFeedback: feedback } : {}),
    });
    await say({ motion: "write", phase: "done", attempt: attempt + 1, ...planSize(plan, budget) });
    const missing = budget.blocks.filter(
      (block) =>
        (block.kind === "experience" || block.kind === "education") &&
        !plan.sections.some((section) => section.entryId === block.entryId),
    );
    // Prose libraries and explicit skill lists have different authoring contracts.
    // Repair a model representation mistake; never relax the evidence validator.
    const skillCorrections = plan.sections.flatMap(section => {
      const entry = library.entries.find(entry => entry.id === section.entryId);
      if (entry?.kind !== "skill") return [];
      if (!entry.skillItems && section.skillItems)
        return [`${entry.id}: the source contains prose, not structured skillItems. Omit skillItems and write concise, supported skill labels in bullets. maxSkills is zero for this block.`];
      if (entry.skillItems && !section.skillItems)
        return [`${entry.id}: select exact labels from the source skillItems array. Do not replace them with prose bullets.`];
      return [];
    });
    invalidSkillFormat = skillCorrections.length > 0;
    // One reading of the writer's answer, reported whatever it found: the blocks it dropped, which
    // ends the build, and the blocks it wrote in the wrong shape, which the next attempt corrects.
    await say({ motion: "check_plan", attempt: attempt + 1, omitted: missing.map(block => block.entryId),
      skillFormatCorrections: skillCorrections.length });
    if (missing.length)
      throw new CvFitFailure(
        "output_invalid",
        "The writer omitted employment or education. No incomplete CV was saved.",
        { omitted: missing.map(block => block.entryId) },
      );
    if (invalidSkillFormat) {
      feedback = { pageCount: feedback?.pageCount ?? maxPages + 1, maxPages,
        previousPlan: plan, corrections: skillCorrections };
      continue;
    }
    // Validate evidence before making any selection.
    materialiseCv(library, plan);
    let selected;
    try {
      selected = await selectCvToFit(library, plan, target, budget, semantic);
    } catch (error) {
      if (!(error instanceof CvLayoutError)) throw error;
      feedback = {
        pageCount: maxPages + 1,
        maxPages,
        previousPlan: plan,
        corrections: [error.message, ...cvBudgetViolations(plan, next())],
      };
      continue;
    }
    await say({ motion: "measure", attempt: attempt + 1, pages: selected.pageCount, maxPages });
    if (selected.semanticOverflows.length && selected.pageCount > maxPages) {
      semanticOverflow = true;
      feedback = { pageCount: selected.pageCount, maxPages, previousPlan: selected.plan,
        corrections: [...selected.semanticOverflows, ...cvBudgetViolations(selected.plan, next())] };
      continue;
    }
    // Trimming is how the measured page count was reached, so it is reported with it, and only
    // when something was actually removed: an attempt that fitted as written says nothing here.
    if (selected.changes.length)
      await say({ motion: "shorten", attempt: attempt + 1, removed: selected.changes.length,
        pages: selected.pageCount, changes: [...new Set(selected.changes)].slice(0, 6) });
    if (selected.pageCount <= maxPages) {
      const notes = [...new Set(selected.changes)];
      if (initial && initial.summary !== selected.content.summary)
        notes.unshift(`Profile rewritten within the ${maxPages}-page content budget.`);
      if (initial && JSON.stringify(initial.sections) !== JSON.stringify(selected.plan.sections))
        notes.unshift(`Achievements and skills adjusted within the ${maxPages}-page content budget. Review the fitted wording.`);
      if (attempt)
        notes.unshift(
          "Wording tightened against smaller per-block budgets after measuring the PDF.",
        );
      return { ...selected.content, fitNotes: notes.slice(0, 50) };
    }
    feedback = {
      pageCount: selected.pageCount,
      maxPages,
      previousPlan: selected.plan,
      corrections: cvBudgetViolations(selected.plan, next()),
    };
  }
  if (invalidSkillFormat)
    // Three attempts have already been spent on this inside one build, so the person chooses the
    // model rather than the system spending a fresh task's attempts on the same answer.
    throw new CvFitFailure(
      "output_invalid",
      "The model repeatedly returned the wrong skill format. Your evidence is unchanged. Retry the build or choose another CV model.",
      { attempts: 3 },
      { resolvedBy: "user", retryable: false, action: "choose_model" },
    );
  if (semanticOverflow)
    throw new CvFitFailure(
      "output_invalid",
      "The writer could not consolidate essential evidence within the CV's content budget without removing its only support. No weakened CV was saved.",
      { attempts: 3 },
    );
  throw new CvFitFailure(
    "page_limit_unfittable",
    `The builder could not fit the minimum employment and education content into ${maxPages} ${maxPages === 1 ? "page" : "pages"} after three budgeted attempts. Reduce the selected evidence blocks or profile detail, or raise the page limit in Settings, then save again.`,
    { pages: feedback?.pageCount ?? maxPages + 1, maxPages, attempts: 3 },
  );
}
