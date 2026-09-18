import { materialiseCv, type CvLibrary, type CvPlan } from "./cv";
import {
  type CvRelevanceTarget,
  createCvWritingBudget,
  cvBudgetViolations,
  cvRelevance,
  type CvWritingBudget,
} from "./cv-budget";
import { renderCvPdfWithReport, CvLayoutError } from "./cv-pdf";
import { cvMaxPages } from "./cv-theme";

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
 * Why fitting gave up, named rather than described.
 *
 * The three ways this can end are three different conversations: the writer dropped evidence it
 * was told to keep, it kept answering in the wrong shape, or the content genuinely does not fit
 * the page limit. Only the last is the person's to resolve, and a caller deciding that must not
 * have to match the sentence we happened to write. The messages are unchanged; the class and its
 * figures are what a caller reads.
 */
export class CvFitFailure extends Error {
  constructor(
    readonly kind: "writer_omitted" | "skill_format" | "page_limit",
    message: string,
    readonly detail: { omitted?: string[]; corrections?: number; pages?: number; maxPages?: number; attempts?: number } = {},
  ) {
    super(message);
    this.name = "CvFitFailure";
  }
}

/** The two coarse stages, unchanged, so a caller written against the old callback still works. */
export type CvFitStage = "writing" | "fitting";

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

/** What the fitter tells its caller: the two old stage names, and the motions behind them. */
export type CvFitSignal = CvFitStage | CvFitEvent;

/** Remove complete, lower-priority achievements; never truncate a claim or shrink fonts. */
export async function selectCvToFit(
  library: CvLibrary,
  source: CvPlan,
  target: CvRelevanceTarget,
  budget: CvWritingBudget,
) {
  const plan = structuredClone(source);
  const changes: string[] = [];
  const maxPages = cvMaxPages(library.theme);
  plan.sections = plan.sections.filter((section) => {
    if (budget.blocks.some((block) => block.entryId === section.entryId))
      return true;
    const entry = library.entries.find((entry) => entry.id === section.entryId);
    if (entry?.kind === "experience" || entry?.kind === "education")
      return true;
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
      const ranked = section.skillItems.map((text, index) => ({
        index,
        score: cvRelevance(text, target) + 1 / (index + 1),
      }));
      const selected = new Set(
        ranked
          .sort((a, b) => b.score - a.score)
          .slice(0, block.maxSkills)
          .map((item) => item.index),
      );
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
      const ranked = section.bullets.map((text, index) => ({
        text,
        index,
        score: cvRelevance(text, target) + 1 / (index + 1),
      }));
      const selected = new Set(
        ranked
          .sort((a, b) => b.score - a.score)
          .slice(0, block.maxBullets)
          .map((item) => item.index),
      );
      section.bullets = section.bullets.filter((_, index) =>
        selected.has(index),
      );
      changes.push(
        `${library.entries.find((entry) => entry.id === section.entryId)!.heading}: prioritised ${section.bullets.length} achievements.`,
      );
    }
  }
  for (;;) {
    const content = materialiseCv(library, plan);
    const { pageCount } = await renderCvPdfWithReport(content);
    if (pageCount <= maxPages) return { plan, content, pageCount, changes };
    // Education is protected. Every employment entry retains at least one bullet.
    const candidates = plan.sections
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
                    cvRelevance(value, target) +
                    (entry.kind === "experience" ? 2 : 0) +
                    1 / (sectionIndex + 1) +
                    1 / (index + 1),
                },
              ],
        );
      })
      .sort((a, b) => a.score - b.score);
    const remove = candidates[0];
    if (!remove) return { plan, content, pageCount, changes };
    const section = plan.sections[remove.sectionIndex]!;
    const values = section.skillItems ?? section.bullets;
    values.splice(remove.index, 1);
    changes.push(
      `${library.entries.find((entry) => entry.id === section.entryId)!.heading}: omitted a lower-priority ${section.skillItems ? "skill" : "bullet"} to fit.`,
    );
    if (!values.length) plan.sections.splice(remove.sectionIndex, 1);
  }
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
 * `onEvent` is the old two-value progress callback widened: the stage names still arrive, in the
 * same order and at the same moments, and the motions behind them arrive as objects beside them.
 * A caller that only understands the strings ignores the objects and behaves exactly as before.
 */
export async function buildFittedCv(
  library: CvLibrary,
  target: CvRelevanceTarget,
  write: (input: CvFitInput) => Promise<CvPlan>,
  initial?: CvPlan,
  onEvent?: (event: CvFitSignal) => void | Promise<void>,
) {
  const maxPages = cvMaxPages(library.theme);
  const say = async (event: CvFitSignal) => { await onEvent?.(event); };
  let feedback: CvFitFeedback | undefined;
  let invalidSkillFormat = false;
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
    );
    // Corrections describe the budget the next attempt will be given, not the one just missed:
    // measured against the current one, a block that fitted it drew no correction at all, and the
    // ones that did quoted figures a quarter larger than the writer's next allocation.
    const next = () => createCvWritingBudget(library, target, Math.pow(0.76, attempt + 1));
    await say("writing");
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
        "writer_omitted",
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
    await say("fitting");
    let selected;
    try {
      selected = await selectCvToFit(library, plan, target, budget);
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
    throw new CvFitFailure(
      "skill_format",
      "The model repeatedly returned the wrong skill format. Your evidence is unchanged. Retry the build or choose another CV model.",
      { attempts: 3 },
    );
  throw new CvFitFailure(
    "page_limit",
    `The builder could not fit the minimum employment and education content into ${maxPages} ${maxPages === 1 ? "page" : "pages"} after three budgeted attempts. Reduce the selected evidence blocks or profile detail, or raise the page limit in Settings, then save again.`,
    { pages: feedback?.pageCount ?? maxPages + 1, maxPages, attempts: 3 },
  );
}
