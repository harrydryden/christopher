import type { CvLibrary, CvPlan } from "./cv";

export type CvBlockBudget = { entryId: string; kind: string; priority: number; maxBullets: number; maxCharacters: number; maxBulletCharacters: number; maxSkills: number };
export type CvWritingBudget = { summaryCharacters: number; totalCharacters: number; blocks: CvBlockBudget[] };
const stop = new Set('with from that this your have will role team work company experience skills across their into and the for are our you'.split(' '));
export function cvRelevance(value: string, target: string): number {
  const words = (text: string) => [...new Set(text.toLowerCase().match(/[a-z][a-z0-9+#&-]{2,}/g) ?? [])].filter(word => !stop.has(word));
  const requested = new Set(words(target));
  return words(value).filter(word => requested.has(word)).length;
}

/** Allocate a conservative writing envelope; actual PDF measurement remains authoritative. */
export function createCvWritingBudget(library: CvLibrary, target: string, scale = 1): CvWritingBudget {
  const roles = library.entries.filter(entry => entry.kind === 'experience').sort((a, b) => {
    const date = (entry: typeof a) => {
      const job = library.employment?.find(job => job.id === entry.employmentId);
      return job ? (job.current ? '9999' : job.endDate || job.startDate) : '';
    };
    return date(b).localeCompare(date(a));
  });
  const education = library.entries.filter(entry => entry.kind === 'education');
  if (roles.length + education.length > 20) throw new Error('Select at most 20 employment and education blocks for this CV. The full library is retained.');
  const skills = library.entries.filter(entry => entry.kind === 'skill')
    .sort((a, b) => cvRelevance(b.details, target) - cvRelevance(a.details, target)).slice(0, Math.min(2, 20 - roles.length - education.length));
  // Headings, callouts, masthead and subsection spacing all consume space, even
  // before achievements are written. More roles therefore mean less prose each.
  const totalCharacters = Math.round(Math.max(2200, 4900 - roles.length * 110 - education.length * 45) * scale);
  const summaryCharacters = Math.round(420 * scale);
  const qualificationCharacters = education.length * Math.round(150 * scale);
  const skillCharacters = skills.length * Math.round(180 * scale);
  const roleCharacters = Math.max(roles.length * 100, totalCharacters - summaryCharacters - qualificationCharacters - skillCharacters);
  const weights = roles.map((entry, index) => 1 + Math.min(2, cvRelevance(entry.heading + ' ' + entry.details, target) / 5) + 2 / (index + 1));
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const blocks: CvBlockBudget[] = roles.map((entry, index) => {
    const maxCharacters = Math.floor(roleCharacters * weights[index]! / sum);
    return { entryId: entry.id, kind: entry.kind, priority: weights[index]!, maxCharacters,
      maxBullets: Math.max(1, Math.min(4, Math.floor(maxCharacters / 160))), maxBulletCharacters: Math.min(260, maxCharacters), maxSkills: 0 };
  });
  blocks.push(...education.map(entry => ({ entryId: entry.id, kind: entry.kind, priority: 10, maxBullets: 6, maxCharacters: Math.round(150 * scale), maxBulletCharacters: Math.round(150 * scale), maxSkills: 0 })));
  blocks.push(...skills.map(entry => ({ entryId: entry.id, kind: entry.kind, priority: 1, maxBullets: 2, maxCharacters: Math.round(180 * scale), maxBulletCharacters: Math.round(90 * scale), maxSkills: Math.max(2, Math.round(5 * scale)) })));
  return { summaryCharacters, totalCharacters, blocks };
}

/** Specific feedback, not just a page count, tells the writer what must change. */
export function cvBudgetViolations(plan: CvPlan, budget: CvWritingBudget): string[] {
  const violations: string[] = [];
  if (plan.summary.length > budget.summaryCharacters) violations.push(`Profile: ${plan.summary.length} characters; budget ${budget.summaryCharacters}.`);
  for (const block of budget.blocks) {
    const section = plan.sections.find(section => section.entryId === block.entryId);
    if (!section) { if (block.kind !== 'skill') violations.push(`Retain ${block.entryId}: ${block.kind} block.`); continue; }
    const values = section.skillItems ?? section.bullets;
    const length = values.reduce((sum, value) => sum + value.length, 0);
    if (length > block.maxCharacters) violations.push(`${block.entryId}: ${length} characters; budget ${block.maxCharacters}.`);
    if (!section.skillItems && section.bullets.some(bullet => bullet.length > block.maxBulletCharacters)) violations.push(`${block.entryId}: keep each bullet within ${block.maxBulletCharacters} characters.`);
    if (values.length > (section.skillItems ? block.maxSkills : block.maxBullets)) violations.push(`${block.entryId}: use at most ${section.skillItems ? block.maxSkills + ' skills' : block.maxBullets + ' bullets'}.`);
  }
  return violations;
}
