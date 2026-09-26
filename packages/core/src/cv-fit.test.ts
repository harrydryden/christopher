import { expect, it, vi } from 'vitest';
import { createCvWritingBudget, cvBudgetViolations } from './cv-budget';
import { buildFittedCv, CV_FIT_PROBLEM_CHARACTERS, cvFitCorrection, selectCvToFit, type CvFitEvent } from './cv-fit';
import { DEFAULT_CV_THEME, materialiseCv, type CvLibrary, type CvPlan } from './cv';
import { renderCvPdfWithReport } from './cv-pdf';
// Every render the fitter asks for, counted, so a test can say how many it took.
const renders = vi.hoisted(() => ({ count: 0 }));
vi.mock('./cv-pdf', async (actual) => {
 const real = await actual<typeof import('./cv-pdf')>();
 return { ...real, renderCvPdfWithReport: async (...args: Parameters<typeof real.renderCvPdfWithReport>) => { renders.count++; return real.renderCvPdfWithReport(...args); } };
});
// The allocations below were calibrated on two pages; the page limit tests scale from there.
const library: CvLibrary = { name:'Example', contact:'London', profile:'Finance leader', theme:{ ...DEFAULT_CV_THEME, maxPages: 2 }, entries:[
 ...Array.from({length:6},(_,i)=>({id:`r${i}`,kind:'experience' as const,heading:`Director · Employer ${i} · 202${i}`,details:i===0?'Financial planning budget reporting':'Operations delivery',confirmedResponsibilities:[i===0?'Financial planning budget reporting':'Operations delivery']})),
 {id:'e',kind:'education',heading:'BSc Economics · University',details:'BSc Economics, University.'},
 {id:'s',kind:'skill',heading:'Tools',details:'SQL',skillItems:['SQL']},
]};
const plan: CvPlan = {summary:'Finance and operations leader.',sections:[...library.entries.slice(0,6).map(entry=>({entryId:entry.id,bullets:[
 'Owned financial planning, budgets and reporting.',
 ...Array.from({length:5},()=> 'Coordinated operational delivery and improved established processes across distributed teams. '.repeat(5)),
]})),{entryId:'e',bullets:['BSc Economics, University.']},{entryId:'s',bullets:['SQL'],skillItems:['SQL']}],gaps:[]};
it('allocates fewer characters as role count grows and prioritises relevant recent evidence',()=>{
 const budget=createCvWritingBudget(library,'Financial planning budgets reporting');
 expect(budget.summaryCharacters).toBeLessThan(500);
 expect(budget.blocks.find(b=>b.entryId==='r0')!.maxCharacters).toBeGreaterThan(budget.blocks.find(b=>b.entryId==='r5')!.maxCharacters);
 expect(budget.blocks.find(b=>b.entryId==='r0')!.maxBullets).toBeLessThanOrEqual(4);
 expect(cvBudgetViolations(plan,budget).length).toBeGreaterThan(0);
});
it('fits a long CV through measured achievement selection, preserving every role and qualification',async()=>{
 expect((await renderCvPdfWithReport(materialiseCv(library,plan))).pageCount).toBeGreaterThan(2);
 const fitted=await selectCvToFit(library,plan,'Financial planning budgets reporting',createCvWritingBudget(library,'Financial planning budgets reporting'));
 expect(fitted.pageCount).toBeLessThanOrEqual(2);
 expect(fitted.content.sections.filter(s=>s.kind==='experience')).toHaveLength(6);
 expect(fitted.content.sections.find(s=>s.entryId==='e')!.bullets).toEqual(['BSc Economics, University.']);
 expect(fitted.content.sections.find(s=>s.entryId==='r0')!.bullets).toContain('Owned financial planning, budgets and reporting.');
 expect(plan.sections[0]!.bullets).toHaveLength(6);
});
it('finds the fewest removals that fit by bisection, rendering a handful of plans rather than one per bullet',async()=>{
 // Six long bullets a role, well past two pages, and no per-block selection to take any first.
 const long: CvPlan = plan;
 const budget = createCvWritingBudget(library,'Financial planning budgets reporting');
 const wide = { ...budget, blocks: budget.blocks.map(block => ({ ...block, maxBullets: 6, maxSkills: 20 })) };
 renders.count = 0;
 const fitted = await selectCvToFit(library, long, 'Financial planning budgets reporting', wide);
 const removed = fitted.changes.filter(change => change.includes('omitted a lower-priority')).length;
 expect(fitted.pageCount).toBeLessThanOrEqual(2);
 // One removal fewer would not have fitted: bisection found the same answer the one-by-one loop did.
 expect(removed).toBeGreaterThan(8);
 const candidates = long.sections.reduce((sum, section) => sum + section.bullets.length, 0);
 expect(renders.count).toBeLessThanOrEqual(2 + Math.ceil(Math.log2(candidates)));
 expect(renders.count).toBeLessThan(removed + 1);
});
it('gives the writer budgets before its first attempt and avoids unnecessary model retries',async()=>{
 const write=vi.fn().mockResolvedValue(plan);
 // The milestone each motion belongs to is the motion catalogue's to say; the fitter reports the
 // motions and nothing else, so there is one vocabulary rather than two that can disagree.
 const motions: string[] = [];
 const fitted=await buildFittedCv(library,'Financial planning budgets reporting',write,undefined,async event => { motions.push(event.motion); });
 expect(motions).toEqual(["write", "write", "check_plan", "measure", "measure", "shorten"]);
 expect(write).toHaveBeenCalledTimes(1);
 expect(write.mock.calls[0]![0].maxPages).toBe(2);
 expect(write.mock.calls[0]![0].writingBudget.blocks).toHaveLength(8);
 expect((await renderCvPdfWithReport(fitted)).pageCount).toBeLessThanOrEqual(2);
 expect(fitted.fitNotes!.length).toBeGreaterThan(0);
});
it('reports each motion of writing and fitting with the figures behind it',async()=>{
 const events: CvFitEvent[] = [];
 await buildFittedCv(library,'Financial planning budgets reporting',async()=>plan,undefined,async event => { events.push(event); });
 expect(events.map(e=>e.motion)).toEqual(['write','write','check_plan','measure','measure','shorten']);
 expect(events[0]).toMatchObject({ motion:'write', phase:'start', attempt:1, budgetScale:1, maxPages:2 });
 expect((events[0] as Extract<CvFitEvent,{motion:'write',phase:'start'}>).budgetCharacters).toBeGreaterThan(0);
 // Six roles written, every bullet counted, and the prose measured before anything was trimmed.
 expect(events[1]).toMatchObject({ motion:'write', phase:'done', attempt:1, roles:6, bullets:38 });
 expect((events[1] as Extract<CvFitEvent,{motion:'write',phase:'done'}>).characters).toBeGreaterThan(1000);
 expect(events[2]).toMatchObject({ motion:'check_plan', attempt:1, omitted:[], skillFormatCorrections:0 });
 // The measurement opens before anything is rendered, and closes with what it rendered to decide.
 expect(events[3]).toEqual({ motion:'measure', phase:'start', attempt:1, maxPages:2 });
 expect(events[4]).toMatchObject({ motion:'measure', phase:'done', attempt:1, maxPages:2, pages:2, outcome:'fits' });
 expect((events[4] as Extract<CvFitEvent,{motion:'measure',phase:'done'}>).renders).toBeGreaterThan(0);
 const shorten = events[5] as Extract<CvFitEvent,{motion:'shorten'}>;
 expect(shorten.removed).toBeGreaterThan(0);
 expect(shorten.changes.length).toBeLessThanOrEqual(6);
 expect(shorten.changes[0]).toContain('prioritised');
});
it('never silently drops employment or education to satisfy the page count',async()=>{
 const events: CvFitEvent[] = [];
 const failing = buildFittedCv(library,'Finance',async()=>({...plan,sections:plan.sections.filter(s=>s.entryId!=='e')}),undefined,async event => { events.push(event); });
 await expect(failing).rejects.toThrow('omitted employment or education');
 // Named in the taxonomy the whole build is classified by: what the writer returned is unusable.
 await expect(failing).rejects.toMatchObject({ kind:'output_invalid', detail:{ omitted:['e'] } });
 // The reading that found it is reported before the build stops, so the page can say what was lost.
 expect(events.at(-1)).toMatchObject({ motion:'check_plan', omitted:['e'] });
});
it('ranks structured skill labels including AI and R, and enforces their allocated count', async () => {
 const source: CvLibrary = {name:'Example',contact:'',profile:'Analyst',theme:{ ...DEFAULT_CV_THEME, maxPages: 2 },entries:[
  {id:'s1',kind:'skill',heading:'Tools',details:'General skills',skillItems:['Excel']},
  {id:'s2',kind:'skill',heading:'Tools',details:'General skills',skillItems:['PowerPoint']},
  {id:'s3',kind:'skill',heading:'Tools',details:'General skills',skillItems:['Excel','PowerPoint','Word','Visio','Jira','AI','R']},
 ]};
 const budget=createCvWritingBudget(source,'AI and R');
 expect(budget.blocks[0]!.entryId).toBe('s3');
 const fitted=await selectCvToFit(source,{summary:'Analyst',sections:[{entryId:'s3',bullets:['Tools'],skillItems:source.entries[2]!.skillItems}],gaps:[]},'AI and R',budget);
 expect(fitted.content.sections[0]!.skillItems).toHaveLength(budget.blocks[0]!.maxSkills);
 expect(fitted.content.sections[0]!.skillItems).toEqual(expect.arrayContaining(['AI','R']));
});
it('repairs a model using structured labels for a legacy prose skill block without relaxing source validation', async () => {
 const source: CvLibrary = { name:'Example',contact:'',profile:'Analyst',entries:[{id:'legacy',kind:'skill',heading:'Data tools',details:'SQL and Python'}] };
 const wrong: CvPlan = {summary:'Analyst',sections:[{entryId:'legacy',bullets:['SQL and Python'],skillItems:['SQL','Python']}],gaps:[]};
 expect(createCvWritingBudget(source,'SQL').blocks[0]!.maxSkills).toBe(0);
 expect(() => materialiseCv(source,wrong)).toThrow('without structured source evidence');
 const write=vi.fn().mockResolvedValueOnce(wrong).mockResolvedValueOnce({summary:'Analyst',sections:[{entryId:'legacy',bullets:['SQL','Python']}],gaps:[]});
 const fitted=await buildFittedCv(source,'SQL and Python',write);
 expect(write).toHaveBeenCalledTimes(2);
 expect(write.mock.calls[1]![0].layoutFeedback.corrections[0]).toContain('legacy: the source contains prose');
 expect(fitted.sections[0]!.skillItems).toBeUndefined();
 expect(fitted.sections[0]!.bullets).toEqual(['SQL','Python']);
 expect((await renderCvPdfWithReport(fitted)).pageCount).toBeLessThanOrEqual(2);
});
it('bounds retries when the writer repeatedly ignores the legacy skill format', async () => {
 const source: CvLibrary = { name:'Example',contact:'',profile:'Analyst',entries:[{id:'legacy',kind:'skill',heading:'Tools',details:'SQL'}] };
 const write=vi.fn().mockResolvedValue({summary:'Analyst',sections:[{entryId:'legacy',bullets:['SQL'],skillItems:['SQL']}],gaps:[]});
 const attempt = buildFittedCv(source,'SQL',write);
 await expect(attempt).rejects.toThrow('wrong skill format');
 // Three attempts inside one build have been spent on it, so the policy hands the next move to
 // the person: another task would meet the same model and the same library.
 await expect(attempt).rejects.toMatchObject({ kind:'output_invalid', detail:{ attempts:3 },
  policy:{ resolvedBy:'user', retryable:false, action:'choose_model' } });
 expect(write).toHaveBeenCalledTimes(3);
});
it('scales the writing budget with the page limit held in the library theme', () => {
 const target='Financial planning budgets reporting';
 const pages=(maxPages:number)=>({...library,theme:{...DEFAULT_CV_THEME,maxPages}});
 const one=createCvWritingBudget(pages(1),target), two=createCvWritingBudget(pages(2),target), three=createCvWritingBudget(pages(3),target);
 expect(three.totalCharacters).toBeGreaterThan(two.totalCharacters);
 expect(one.totalCharacters).toBeLessThan(two.totalCharacters);
 // The profile sits in the fixed masthead: it never grows, and shrinks only for one page.
 expect(three.summaryCharacters).toBe(two.summaryCharacters);
 expect(one.summaryCharacters).toBeLessThan(two.summaryCharacters);
 const role=(budget:ReturnType<typeof createCvWritingBudget>)=>budget.blocks.find(b=>b.entryId==='r0')!;
 expect(role(three).maxBullets).toBeGreaterThan(role(two).maxBullets);
 expect(role(three).maxBullets).toBeLessThanOrEqual(6);
 expect(role(one).maxBullets).toBeLessThanOrEqual(2);
 expect(three.blocks.find(b=>b.entryId==='s')!.maxSkills).toBeGreaterThan(two.blocks.find(b=>b.entryId==='s')!.maxSkills);
 // Without a theme the default three-page limit applies.
 const { theme:_theme, ...untitled }=library;
 expect(createCvWritingBudget(untitled,target).totalCharacters).toBe(three.totalCharacters);
});
it('fits to the page limit in the library theme, keeping more achievements when more pages are allowed', async () => {
 const target='Financial planning budgets reporting';
 const pages=(maxPages:number)=>({...library,theme:{...DEFAULT_CV_THEME,maxPages}});
 const bullets=(content:{sections:{bullets:string[]}[]})=>content.sections.reduce((sum,section)=>sum+section.bullets.length,0);
 const two=await selectCvToFit(pages(2),plan,target,createCvWritingBudget(pages(2),target));
 const three=await selectCvToFit(pages(3),plan,target,createCvWritingBudget(pages(3),target));
 expect(two.pageCount).toBeLessThanOrEqual(2);
 expect(three.pageCount).toBe(3);
 expect(three.content.theme?.maxPages).toBe(3);
 expect(bullets(three.content)).toBeGreaterThan(bullets(two.content));
 expect(three.content.sections.filter(s=>s.kind==='experience')).toHaveLength(6);
 const fitted=await buildFittedCv(pages(3),target,async()=>plan);
 expect((await renderCvPdfWithReport(fitted)).pageCount).toBe(3);
 expect((await renderCvPdfWithReport(fitted)).maxPages).toBe(3);
});
it('reports the page limit when the minimum content cannot fit one page', async () => {
 const minimal: CvPlan={...plan,sections:plan.sections.map(section=>section.entryId.startsWith('r')?{...section,bullets:[plan.sections[1]!.bullets[1]!]}:section)};
 const write=vi.fn().mockResolvedValue(minimal);
 const attempt = buildFittedCv({...library,theme:{...DEFAULT_CV_THEME,maxPages:1}},'Finance',write);
 await expect(attempt).rejects.toThrow('into 1 page after three budgeted attempts');
 // The caller is told what it is: a page limit the content will not meet, with both figures.
 await expect(attempt).rejects.toMatchObject({ kind:'page_limit_unfittable', detail:{ maxPages:1, attempts:3 } });
 expect(write).toHaveBeenCalledTimes(3);
 expect(write.mock.calls[1]![0].layoutFeedback?.maxPages).toBe(1);
 expect(write.mock.calls[1]![0].layoutFeedback?.pageCount).toBeGreaterThan(1);
});

it('weights relevance by requirement importance, as the assessment weights the score', async () => {
 const { cvRelevance, cvRelevanceTerms } = await import('./cv-budget');
 const terms = cvRelevanceTerms([
  { id: 'a', label: 'Budgets', quote: 'own the annual budget', importance: 'essential', category: 'experience' },
  { id: 'b', label: 'Reporting', quote: 'monthly reporting', importance: 'desirable', category: 'experience' },
 ]);
 expect(cvRelevance('Owned the annual budget and monthly reporting', terms)).toBe(6);
 expect(cvRelevance('Owned the annual budget and monthly reporting', 'own the annual budget monthly reporting')).toBe(4);
});
it('budgets one interest block on a multi-page CV and lets the fitter drop it first under pressure', async () => {
 const withInterest: CvLibrary = { ...library, entries: [...library.entries, { id: 'i', kind: 'interest', heading: 'Interests', details: 'Marathon running' }] };
 const budget = createCvWritingBudget(withInterest, 'Finance');
 expect(budget.blocks.find(block => block.entryId === 'i')).toMatchObject({ kind: 'interest', maxBullets: 2 });
 expect(createCvWritingBudget({ ...withInterest, theme: { ...DEFAULT_CV_THEME, maxPages: 1 } }, 'Finance').blocks.some(block => block.entryId === 'i')).toBe(false);
 const short: CvPlan = { summary: 'Finance leader.', sections: [...library.entries.slice(0, 6).map(entry => ({ entryId: entry.id, bullets: ['Owned financial planning.'] })), { entryId: 'e', bullets: ['BSc Economics, University.'] }, { entryId: 'i', bullets: ['Marathon running'] }], gaps: [] };
 expect(cvBudgetViolations(short, budget).some(violation => violation.startsWith('Retain i'))).toBe(false);
 const fitted = await selectCvToFit(withInterest, short, 'Finance', budget);
 expect(fitted.content.sections.some(section => section.entryId === 'i')).toBe(true);
 const crowded = await selectCvToFit(withInterest, { ...plan, sections: [...plan.sections, { entryId: 'i', bullets: ['Marathon running'] }] }, 'Finance', budget);
 expect(crowded.content.sections.some(section => section.entryId === 'i')).toBe(false);
 expect(crowded.content.sections.filter(section => section.kind === 'experience')).toHaveLength(6);
});
it('corrects a retry against the budget it will be given, not the one it just missed', async () => {
 const minimal: CvPlan = { ...plan, sections: plan.sections.map(section => section.entryId.startsWith('r') ? { ...section, bullets: [plan.sections[1]!.bullets[1]!] } : section) };
 const write = vi.fn().mockResolvedValue(minimal);
 await expect(buildFittedCv({ ...library, theme: { ...DEFAULT_CV_THEME, maxPages: 1 } }, 'Finance', write)).rejects.toThrow('after three budgeted attempts');
 const length = minimal.sections[0]!.bullets.reduce((sum, bullet) => sum + bullet.length, 0);
 const budgetFor = (attempt: number) => write.mock.calls[attempt]![0].writingBudget.blocks.find((block: { entryId: string }) => block.entryId === 'r5')!.maxCharacters;
 expect(budgetFor(1)).toBeLessThan(budgetFor(0));
 expect(write.mock.calls[1]![0].layoutFeedback!.corrections).toContain(`r5: ${length} characters; budget ${budgetFor(1)}.`);
 expect(write.mock.calls[1]![0].layoutFeedback!.corrections).not.toContain(`r5: ${length} characters; budget ${budgetFor(0)}.`);
});
it('corrects an answer that cannot be materialised with one more writing call, telling the writer exactly what was wrong', async () => {
 const events: CvFitEvent[] = [];
 // An evidence reference the Library does not hold: the writer's mistake, not the Library's.
 const invented: CvPlan = { ...plan, sections: [...plan.sections, { entryId: 'invented', bullets: ['Made something up'] }] };
 const write = vi.fn().mockResolvedValueOnce(invented).mockResolvedValueOnce(plan);
 const fitted = await buildFittedCv(library, 'Financial planning budgets reporting', write, undefined, async event => { events.push(event); });
 expect(write).toHaveBeenCalledTimes(2);
 expect(write.mock.calls[1]![0].layoutFeedback.corrections[0]).toContain('unknown, unconfirmed or repeated evidence references');
 expect(write.mock.calls[1]![0].layoutFeedback.previousPlan).toBe(invented);
 // The second attempt is a rewrite asked for by a correction: nothing was measured, so no reason.
 const rewrite = events.filter(event => event.motion === 'write' && event.phase === 'start')[1]!;
 expect(rewrite).toMatchObject({ attempt: 2, corrections: 1 });
 expect(rewrite).not.toHaveProperty('reason');
 expect(fitted.sections.some(section => section.entryId === 'invented')).toBe(false);
});
it('hands an answer that stays unusable after three corrected attempts to the person, as output_invalid', async () => {
 const invented: CvPlan = { ...plan, sections: [...plan.sections, { entryId: 'invented', bullets: ['Made something up'] }] };
 const write = vi.fn().mockResolvedValue(invented);
 const attempt = buildFittedCv(library, 'Finance', write);
 await expect(attempt).rejects.toMatchObject({ kind: 'output_invalid', detail: { attempts: 3 },
  policy: { resolvedBy: 'user', retryable: false, action: 'choose_model' } });
 await expect(attempt).rejects.toThrow('could not be used after three corrected attempts');
 expect(write).toHaveBeenCalledTimes(3);
});
it('tells a rewrite why the attempt before it did not stand, with what that attempt measured', async () => {
 const minimal: CvPlan = { ...plan, sections: plan.sections.map(section => section.entryId.startsWith('r') ? { ...section, bullets: [plan.sections[1]!.bullets[1]!] } : section) };
 const events: CvFitEvent[] = [];
 await expect(buildFittedCv({ ...library, theme: { ...DEFAULT_CV_THEME, maxPages: 1 } }, 'Finance', async () => minimal, undefined,
  async event => { events.push(event); })).rejects.toThrow('after three budgeted attempts');
 const starts = events.filter((event): event is Extract<CvFitEvent, { motion: 'write'; phase: 'start' }> => event.motion === 'write' && event.phase === 'start');
 expect(starts[0]).not.toHaveProperty('reason');
 expect(starts[1]).toMatchObject({ attempt: 2, reason: 'overflow', maxPages: 1 });
 expect(starts[1]!.pages).toBeGreaterThan(1);
 const closes = events.filter(event => event.motion === 'measure' && event.phase === 'done');
 expect(closes.length).toBe(3);
 expect(closes.every(event => event.motion === 'measure' && event.phase === 'done' && event.outcome === 'overflow')).toBe(true);
});
it('hands a page limit that only removing sole essential evidence could meet to the person after one build, not three', async () => {
 // Fifteen roles that each keep their one achievement, and an interest the page has no room for
 // that is nevertheless the only evidence for an essential requirement: nothing can be trimmed.
 const roles = Array.from({ length: 15 }, (_, i) => ({ id: `x${i}`, kind: 'experience' as const, heading: `Director · Employer ${i} · 20${10 + i}`,
  details: 'Coordinated operational delivery across distributed teams. '.repeat(8).trim(), confirmedResponsibilities: ['Coordinated operational delivery across distributed teams. '.repeat(8).trim()] }));
 const crowded: CvLibrary = { name: 'Example', contact: 'London', profile: 'Leader', theme: { ...DEFAULT_CV_THEME, maxPages: 1 }, entries: [
  ...roles, { id: 'i', kind: 'interest', heading: 'Interests', details: 'Chaired a national charity board' }] };
 const rubric = { caveats: [], requirements: [{ id: 'r1', label: 'Board governance', quote: 'board', importance: 'essential' as const, category: 'experience' as const }] };
 const tailoring = { requirements: [{ requirementId: 'r1', status: 'demonstrated' as const, evidence: [{ sourceId: 'entry:i:row:0', quote: 'Chaired a national charity board' }], reason: 'Direct.' }], gapQuestions: [] };
 const written: CvPlan = { summary: 'Leader', summarySources: [{ sourceId: 'source:profile', quote: 'Leader' }], sections: [
  ...roles.map(role => ({ entryId: role.id, bullets: [role.details], bulletSources: [[{ sourceId: `entry:${role.id}:row:0`, quote: role.details }]] })),
  { entryId: 'i', bullets: ['Chaired a national charity board'], bulletSources: [[{ sourceId: 'entry:i:row:0', quote: 'Chaired a national charity board' }]] }], gaps: [] };
 const write = vi.fn().mockResolvedValue(written);
 const attempt = buildFittedCv(crowded, 'board', write, undefined, undefined, { plan: tailoring, rubric });
 // The person's page limit, with the reason: the essential evidence is why it cannot shrink.
 await expect(attempt).rejects.toMatchObject({ kind: 'page_limit_unfittable', detail: { maxPages: 1, attempts: 3, essential: true } });
 await expect(attempt).rejects.toSatisfy((error: unknown) => (error as { policy: object }).policy && Object.keys((error as { policy: object }).policy).length === 0);
 expect(write).toHaveBeenCalledTimes(3);
});
// A planned build: every summary and bullet cites the Library row it came from.
const sourcedTarget = {
 rubric: { caveats: [], requirements: [{ id: 'fin', label: 'Financial planning', quote: 'planning', importance: 'essential' as const, category: 'experience' as const }] },
 plan: { requirements: [{ requirementId: 'fin', status: 'demonstrated' as const, evidence: [{ sourceId: 'entry:r0:row:0', quote: 'Financial planning budget reporting' }], reason: 'Direct.' }], gapQuestions: [] },
};
const sourced: CvPlan = { summary: 'Finance leader', summarySources: [{ sourceId: 'source:profile', quote: 'Finance leader' }], gaps: [], sections: [
 ...library.entries.slice(0, 6).map(entry => ({ entryId: entry.id, bullets: [entry.confirmedResponsibilities![0]!],
  bulletSources: [[{ sourceId: `entry:${entry.id}:row:0`, quote: entry.confirmedResponsibilities![0]! }]] })),
 { entryId: 'e', bullets: ['BSc Economics, University.'], bulletSources: [[{ sourceId: 'entry:e:row:0', quote: 'BSc Economics, University.' }]] }] };
const citing = (sourceId: string): CvPlan => ({ ...sourced, sections: sourced.sections.map((section, index) => index === 0
 ? { ...section, bulletSources: [[{ sourceId, quote: section.bullets[0]! }]] } : section) });
it('corrects a citation of a source the Library does not hold inside the build, with the problem quoted as bounded data', async () => {
 const write = vi.fn().mockResolvedValueOnce(citing('entry:r0:row:99')).mockResolvedValueOnce(sourced);
 const fitted = await buildFittedCv(library, 'Financial planning', write, undefined, undefined, sourcedTarget);
 expect(write).toHaveBeenCalledTimes(2);
 const correction: string = write.mock.calls[1]![0].layoutFeedback.corrections[0];
 expect(correction).toMatch(/<rejected_answer_problem>Unknown CV source: entry:r0:row:99<\/rejected_answer_problem>/);
 expect(fitted.sections.find(section => section.entryId === 'r0')!.bullets).toEqual(['Financial planning budget reporting']);
 // An answer quoting something enormous is cut short before it goes back to the writer.
 expect(cvFitCorrection('x'.repeat(5_000)).length).toBeLessThan(CV_FIT_PROBLEM_CHARACTERS + 400);
});
it('hands three unverifiable answers to the person, naming each attempt\'s problem', async () => {
 const write = vi.fn()
  .mockResolvedValueOnce(citing('entry:r0:row:97'))
  .mockResolvedValueOnce(citing('entry:r0:row:98'))
  .mockResolvedValueOnce(citing('entry:r0:row:99'));
 const attempt = buildFittedCv(library, 'Financial planning', write, undefined, undefined, sourcedTarget);
 await expect(attempt).rejects.toMatchObject({ kind: 'output_invalid', policy: { resolvedBy: 'user', retryable: false } });
 const message = await attempt.catch((error: Error) => error.message);
 for (const id of ['entry:r0:row:97', 'entry:r0:row:98', 'entry:r0:row:99']) expect(message).toContain(id);
 expect(write).toHaveBeenCalledTimes(3);
});
