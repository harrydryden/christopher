import { expect, it, vi } from 'vitest';
import { createCvWritingBudget, cvBudgetViolations } from './cv-budget';
import { buildFittedCv, selectCvToFit } from './cv-fit';
import { materialiseCv, type CvLibrary, type CvPlan } from './cv';
import { renderCvPdfWithReport } from './cv-pdf';
const library: CvLibrary = { name:'Example', contact:'London', profile:'Finance leader', entries:[
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
 const fitted=await buildFittedCv(library,'Financial planning budgets reporting',write);
 expect(write).toHaveBeenCalledTimes(1);
 expect(write.mock.calls[0]![0].writingBudget.blocks).toHaveLength(8);
 expect((await renderCvPdfWithReport(fitted)).pageCount).toBeLessThanOrEqual(2);
 expect(fitted.fitNotes!.length).toBeGreaterThan(0);
});
it('never silently drops employment or education to satisfy the page count',async()=>{
 await expect(buildFittedCv(library,'Finance',async()=>({...plan,sections:plan.sections.filter(s=>s.entryId!=='e')}))).rejects.toThrow('omitted employment or education');
});
