import { expect, it, vi } from 'vitest';
import { createCvWritingBudget, cvBudgetViolations } from './cv-budget';
import { buildFittedCv, selectCvToFit, type CvFitEvent } from './cv-fit';
import { DEFAULT_CV_THEME, materialiseCv, type CvLibrary, type CvPlan } from './cv';
import { renderCvPdfWithReport } from './cv-pdf';
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
it('gives the writer budgets before its first attempt and avoids unnecessary model retries',async()=>{
 const write=vi.fn().mockResolvedValue(plan);
 // The milestone each motion belongs to is the motion catalogue's to say; the fitter reports the
 // motions and nothing else, so there is one vocabulary rather than two that can disagree.
 const motions: string[] = [];
 const fitted=await buildFittedCv(library,'Financial planning budgets reporting',write,undefined,async event => { motions.push(event.motion); });
 expect(motions).toEqual(["write", "write", "check_plan", "measure", "shorten"]);
 expect(write).toHaveBeenCalledTimes(1);
 expect(write.mock.calls[0]![0].maxPages).toBe(2);
 expect(write.mock.calls[0]![0].writingBudget.blocks).toHaveLength(8);
 expect((await renderCvPdfWithReport(fitted)).pageCount).toBeLessThanOrEqual(2);
 expect(fitted.fitNotes!.length).toBeGreaterThan(0);
});
it('reports each motion of writing and fitting with the figures behind it',async()=>{
 const events: CvFitEvent[] = [];
 await buildFittedCv(library,'Financial planning budgets reporting',async()=>plan,undefined,async event => { events.push(event); });
 expect(events.map(e=>e.motion)).toEqual(['write','write','check_plan','measure','shorten']);
 expect(events[0]).toMatchObject({ motion:'write', phase:'start', attempt:1, budgetScale:1, maxPages:2 });
 expect((events[0] as Extract<CvFitEvent,{phase:'start'}>).budgetCharacters).toBeGreaterThan(0);
 // Six roles written, every bullet counted, and the prose measured before anything was trimmed.
 expect(events[1]).toMatchObject({ motion:'write', phase:'done', attempt:1, roles:6, bullets:38 });
 expect((events[1] as Extract<CvFitEvent,{phase:'done'}>).characters).toBeGreaterThan(1000);
 expect(events[2]).toMatchObject({ motion:'check_plan', attempt:1, omitted:[], skillFormatCorrections:0 });
 expect(events[3]).toMatchObject({ motion:'measure', attempt:1, maxPages:2, pages:2 });
 const shorten = events[4] as Extract<CvFitEvent,{motion:'shorten'}>;
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
