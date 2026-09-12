import { materialiseCv, type CvLibrary, type CvPlan } from './cv';
import { createCvWritingBudget, cvBudgetViolations, cvRelevance, type CvWritingBudget } from './cv-budget';
import { renderCvPdfWithReport, CV_MAX_PAGES } from './cv-pdf';

export type CvFitFeedback = { pageCount: number; maxPages: number; previousPlan: CvPlan; corrections: string[] };
export type CvFitInput = { writingBudget: CvWritingBudget; layoutFeedback?: CvFitFeedback };

/** Remove complete, lower-priority achievements; never truncate a claim or shrink fonts. */
export async function selectCvToFit(library: CvLibrary, source: CvPlan, target: string, budget: CvWritingBudget) {
  const plan = structuredClone(source);
  const changes: string[] = [];
  plan.sections = plan.sections.filter(section => {
    if (budget.blocks.some(block => block.entryId === section.entryId)) return true;
    const entry = library.entries.find(entry => entry.id === section.entryId);
    if (entry?.kind === 'experience' || entry?.kind === 'education') return true;
    changes.push(`${entry?.heading ?? section.entryId}: omitted optional block to reserve space for experience and qualifications.`);
    return false;
  });
  // Keep chronological sections, but use relevance to select their strongest bullets.
  for (const section of plan.sections) {
    const block = budget.blocks.find(block => block.entryId === section.entryId);
    if (block?.kind === 'skill' && section.skillItems && section.skillItems.length > block.maxSkills) {
      const ranked = section.skillItems.map((text, index) => ({ index, score: cvRelevance(text, target) + 1 / (index + 1) }));
      const selected = new Set(ranked.sort((a, b) => b.score - a.score).slice(0, block.maxSkills).map(item => item.index));
      section.skillItems = section.skillItems.filter((_, index) => selected.has(index));
      changes.push(`${library.entries.find(entry => entry.id === section.entryId)!.heading}: prioritised ${section.skillItems.length} relevant skills.`);
    }
    if (block?.kind === 'experience' && section.bullets.length > block.maxBullets) {
      const ranked = section.bullets.map((text, index) => ({ text, index, score: cvRelevance(text, target) + 1 / (index + 1) }));
      const selected = new Set(ranked.sort((a, b) => b.score - a.score).slice(0, block.maxBullets).map(item => item.index));
      section.bullets = section.bullets.filter((_, index) => selected.has(index));
      changes.push(`${library.entries.find(entry => entry.id === section.entryId)!.heading}: prioritised ${section.bullets.length} achievements.`);
    }
  }
  for (;;) {
    const content = materialiseCv(library, plan);
    const { pageCount } = await renderCvPdfWithReport(content);
    if (pageCount <= CV_MAX_PAGES) return { plan, content, pageCount, changes };
    // Education is protected. Every employment entry retains at least one bullet.
    const candidates = plan.sections.flatMap((section, sectionIndex) => {
      const entry = library.entries.find(entry => entry.id === section.entryId)!;
      if (entry.kind === 'education') return [];
      const values = section.skillItems ?? section.bullets;
      return values.flatMap((value, index) => entry.kind === 'experience' && values.length === 1 ? [] : [{ sectionIndex, index,
        score: cvRelevance(value, target) + (entry.kind === 'experience' ? 2 : 0) + 1 / (sectionIndex + 1) + 1 / (index + 1) }]);
    }).sort((a, b) => a.score - b.score);
    const remove = candidates[0];
    if (!remove) return { plan, content, pageCount, changes };
    const section = plan.sections[remove.sectionIndex]!;
    const values = section.skillItems ?? section.bullets;
    values.splice(remove.index, 1);
    changes.push(`${library.entries.find(entry => entry.id === section.entryId)!.heading}: omitted a lower-priority ${section.skillItems ? 'skill' : 'bullet'} to fit.`);
    if (!values.length) plan.sections.splice(remove.sectionIndex, 1);
  }
}

/** Bounded writing and measured selection, shared by fresh generation and draft fitting. */
export async function buildFittedCv(library: CvLibrary, target: string, write: (input: CvFitInput) => Promise<CvPlan>, initial?: CvPlan) {
  let feedback: CvFitFeedback | undefined;
  if (initial) {
    const content = materialiseCv(library, initial);
    const report = await renderCvPdfWithReport(content);
    feedback = { pageCount: report.pageCount, maxPages: CV_MAX_PAGES, previousPlan: initial, corrections: ['Refit this saved wording to the supplied block budgets. Preserve qualifications and employment history.'] };
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const budget = createCvWritingBudget(library, target, Math.pow(0.76, attempt));
    const plan = await write({ writingBudget: budget, ...(feedback ? { layoutFeedback: feedback } : {}) });
    const missing = budget.blocks.filter(block => block.kind !== 'skill' && !plan.sections.some(section => section.entryId === block.entryId));
    if (missing.length) throw new Error('The writer omitted employment or education. No incomplete CV was saved.');
    // Validate evidence before making any selection.
    materialiseCv(library, plan);
    const selected = await selectCvToFit(library, plan, target, budget);
    if (selected.pageCount <= CV_MAX_PAGES) {
      const notes = [...new Set(selected.changes)];
      if (initial && initial.summary !== selected.content.summary) notes.unshift('Profile rewritten within the two-page content budget.');
      if (attempt) notes.unshift('Wording tightened against smaller per-block budgets after measuring the PDF.');
      return { ...selected.content, fitNotes: notes.slice(0, 50) };
    }
    feedback = { pageCount: selected.pageCount, maxPages: CV_MAX_PAGES, previousPlan: selected.plan, corrections: cvBudgetViolations(selected.plan, budget) };
  }
  throw new Error('The builder could not fit the minimum employment and education content after three budgeted attempts. Reduce the selected evidence blocks or profile detail and try Fit to two pages again.');
}
