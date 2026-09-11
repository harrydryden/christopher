"use client";
import { updateEmploymentIndustries, type CvLibrary, type Employment } from "@christopher/core/cv";

const input = "w-full min-w-28 rounded border border-slate-300 p-2 text-sm dark:border-slate-700 dark:bg-slate-950";
export function EmploymentHistoryTable({ employment, entries, onChange }: {
  employment: Employment[]; entries: CvLibrary["entries"]; onChange: (jobs: Employment[]) => void;
}) {
  const companies = [...new Set(employment.map(job => job.company.trim()).filter(Boolean))].sort();
  function update(id: string, patch: Partial<Employment>) {
    onChange(employment.map(job => job.id === id ? { ...job, ...patch } : job));
  }
  return <section aria-labelledby="employment-heading" className="space-y-3 rounded border border-slate-200 p-3">
    <h2 id="employment-heading" className="text-lg font-semibold">Employment history</h2>
    <p className="text-sm text-slate-500">One row per job. Add comma-separated industry descriptions (for example: Workplace mental health, SaaS). Descriptions are shared across jobs at the same company. The CV builder selects up to two relevant descriptions for each application.</p>
    <p className="text-xs text-slate-500">Dates: YYYY-MM (for example 2025-08), or YYYY if only the year is known. Leave unknown dates blank. Separate jobs at the same company stay separate.</p>
    <datalist id="employment-companies">{companies.map(company => <option key={company} value={company} />)}</datalist>
    <div className="overflow-x-auto"><table className="w-full text-left text-sm">
      <thead><tr>{["Company", "Industry descriptions", "Job title", "Start date", "End date", "Current", ""].map((label, i) => <th scope="col" className="p-2" key={i}>{label}</th>)}</tr></thead>
      <tbody>{employment.map((job, i) => {
        const hasEvidence = entries.some(entry => entry.employmentId === job.id);
        return <tr key={job.id}>
          <td className="p-1"><input required maxLength={160} aria-label={`Job ${i + 1} company`} list="employment-companies" className={input} value={job.company} onChange={e => {
            const company = e.target.value;
            const existing = employment.find(item => item.id !== job.id && item.company.trim().toLowerCase() === company.trim().toLowerCase());
            update(job.id, { company, ...(existing ? { industryDescriptions: existing.industryDescriptions ?? "" } : {}) });
          }} /></td>
          <td className="p-1"><textarea rows={2} maxLength={1200} aria-label={`Job ${i + 1} industry descriptions`} placeholder="Workplace mental health, SaaS" className={`${input} min-w-52`} value={job.industryDescriptions ?? ""} onChange={e => onChange(updateEmploymentIndustries(employment, job.id, e.target.value))} /></td>
          <td className="p-1"><input required maxLength={160} aria-label={`Job ${i + 1} title`} className={`${input} min-w-52`} value={job.jobTitle} onChange={e => update(job.id, { jobTitle: e.target.value })} /></td>
          <td className="p-1"><input aria-label={`Job ${i + 1} start date`} placeholder="YYYY-MM" pattern="[0-9]{4}(-[0-9]{2})?" className={input} value={job.startDate} onChange={e => update(job.id, { startDate: e.target.value })} /></td>
          <td className="p-1"><input disabled={job.current} aria-label={`Job ${i + 1} end date`} placeholder={job.current ? "Present" : "YYYY-MM"} pattern="[0-9]{4}(-[0-9]{2})?" className={input} value={job.endDate} onChange={e => update(job.id, { endDate: e.target.value })} /></td>
          <td className="p-2"><input type="checkbox" aria-label={`Job ${i + 1} current`} checked={job.current} onChange={e => update(job.id, { current: e.target.checked, endDate: e.target.checked ? "" : job.endDate })} /></td>
          <td className="p-2"><button type="button" disabled={hasEvidence} title={hasEvidence ? "This job has an evidence block. Archive the block to exclude it from CVs." : "Remove job"} aria-label={`Remove job ${i + 1}`} className="underline disabled:opacity-40" onClick={() => onChange(employment.filter(item => item.id !== job.id))}>Remove</button></td>
        </tr>;
      })}</tbody>
    </table></div>
    {!employment.length && <p className="text-sm">Add your first job, then add its responsibilities and outcomes below.</p>}
    <button type="button" className="text-sm underline" onClick={() => onChange([...employment, { id: crypto.randomUUID(), company: "", jobTitle: "", startDate: "", endDate: "", current: false }])}>Add job</button>
  </section>;
}
