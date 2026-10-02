"use client";
import { isActiveEvidence, responsibilityRows, updateEmploymentIndustries } from "@ava/core/cv-helpers";
import type { CvLibrary, Employment } from "@ava/core/cv";
import { inputClass } from "@/components/Field";
import { TH, TR } from "@/components/table";
import styles from "./EmploymentHistoryTable.module.css";

// Every control in the grid is the same height, so the rows read as rows
// rather than a scatter of boxes. Industry descriptions is a long field but
// one line is enough to see and edit it; it scrolls horizontally.
const cell = `md:h-9 md:py-0 ${inputClass}`;
const cellPad = "block px-3 py-2 md:table-cell md:p-1.5 md:align-middle";

/**
 * What the confirm asks before a job is removed.
 *
 * Removing a job archives its evidence rather than deleting it: the rows stay in the versions
 * already saved and in the CVs already built, and are shown and counted nowhere else. That is
 * worth a sentence and a confirm when there is anything to archive — and one more sentence for
 * the way back, because a person who removes the wrong job needs to know there is one before they
 * answer, not after.
 */
export function jobRemovalConfirm(job: Employment, rows: number): string {
  const name = [job.company.trim(), job.jobTitle.trim()].filter(Boolean).join(" · ") || "this job";
  return `Remove ${name} and archive its ${rows} ${rows === 1 ? "row" : "rows"}? They stay in earlier versions and in CVs already built. You can restore it from Archived jobs below.`;
}

export function EmploymentHistoryTable({ employment, entries, onChange, onRemove }: {
  employment: Employment[]; entries: CvLibrary["entries"]; onChange: (jobs: Employment[]) => void;
  /** Take this job out of the Library, with whatever evidence was written for it. */
  onRemove: (job: Employment) => void;
}) {
  const companies = [...new Set(employment.map(job => job.company.trim()).filter(Boolean))].sort();
  function update(id: string, patch: Partial<Employment>) {
    onChange(employment.map(job => job.id === id ? { ...job, ...patch } : job));
  }
  const rowsWritten = (job: Employment) => {
    const entry = entries.find(item => item.kind === "experience" && item.employmentId === job.id && isActiveEvidence(item));
    return entry ? responsibilityRows(entry.details).length : 0;
  };
  function remove(job: Employment) {
    const rows = rowsWritten(job);
    if (rows > 0 && !window.confirm(jobRemovalConfirm(job, rows))) return;
    onRemove(job);
  }
  return <section aria-labelledby="employment-heading" className={`${styles.employment} space-y-3`}>
    <h2 id="employment-heading" className="ds-pixel text-12">Employment history</h2>
    <datalist id="employment-companies">{companies.map(company => <option key={company} value={company} />)}</datalist>
    {/* One control for every field at every width: a table on desktop and stacked jobs on a phone.
        Hidden duplicate required inputs would still take part in browser form validation. */}
    {employment.length > 0 && <div className="overflow-x-auto border-2 border-line"><table className="block w-full border-collapse text-14 md:table md:min-w-[720px]">
      <thead className="hidden bg-sunken text-left md:table-header-group"><tr>
        <TH className="min-w-40">Company</TH>
        <TH className="min-w-56">Industry descriptions</TH>
        <TH className="min-w-56">Job title</TH>
        <TH className="w-32">Start date</TH>
        <TH className="w-32">End date</TH>
        <TH className="w-20 text-center">Current</TH>
        <TH>Remove</TH>
      </tr></thead>
      <tbody className="block md:table-row-group">{employment.map((job, i) => <TR key={job.id} className="mb-3 block border-2 border-line-muted md:mb-0 md:table-row md:border-x-0 md:border-b-0">
          <td className={cellPad}><span className={`${styles.fieldLabel} mb-1 block text-12 font-semibold md:hidden`}>Company</span><input required maxLength={160} aria-label={`Job ${i + 1} company`} list="employment-companies" className={cell} value={job.company} onChange={e => {
            const company = e.target.value;
            const existing = employment.find(item => item.id !== job.id && item.company.trim().toLowerCase() === company.trim().toLowerCase());
            update(job.id, { company, ...(existing ? { industryDescriptions: existing.industryDescriptions ?? "" } : {}) });
          }} /></td>
          <td className={cellPad}><span className={`${styles.fieldLabel} mb-1 block text-12 font-semibold md:hidden`}>Industry descriptions</span><input maxLength={1200} aria-label={`Job ${i + 1} industry descriptions`} placeholder="Workplace mental health, SaaS" className={cell} value={job.industryDescriptions ?? ""} onChange={e => onChange(updateEmploymentIndustries(employment, job.id, e.target.value))} /></td>
          <td className={cellPad}><span className={`${styles.fieldLabel} mb-1 block text-12 font-semibold md:hidden`}>Job title</span><input required maxLength={160} aria-label={`Job ${i + 1} title`} className={cell} value={job.jobTitle} onChange={e => update(job.id, { jobTitle: e.target.value })} /></td>
          <td className={cellPad}><span className={`${styles.fieldLabel} mb-1 block text-12 font-semibold md:hidden`}>Start date</span><input aria-label={`Job ${i + 1} start date`} placeholder="YYYY-MM" pattern="[0-9]{4}(-[0-9]{2})?" className={cell} value={job.startDate} onChange={e => update(job.id, { startDate: e.target.value })} /></td>
          <td className={cellPad}><span className={`${styles.fieldLabel} mb-1 block text-12 font-semibold md:hidden`}>End date</span><input disabled={job.current} aria-label={`Job ${i + 1} end date`} placeholder={job.current ? "Present" : "YYYY-MM"} pattern="[0-9]{4}(-[0-9]{2})?" className={`${cell} disabled:opacity-40`} value={job.endDate} onChange={e => update(job.id, { endDate: e.target.value })} /></td>
          <td className={`${cellPad} text-center`}><label className="flex items-center gap-2 md:justify-center"><input type="checkbox" aria-label={`Job ${i + 1} current`} checked={job.current} onChange={e => update(job.id, { current: e.target.checked, endDate: e.target.checked ? "" : job.endDate })} /><span className={`${styles.currentLabel} text-12 md:hidden`}>Current job</span></label></td>
          <td className={`${cellPad} whitespace-nowrap text-right`}><button type="button" title="Remove job" aria-label={`Remove job ${i + 1}`} className="text-12 text-muted underline hover:text-fg" onClick={() => remove(job)}>Remove</button></td>
        </TR>)}</tbody>
    </table></div>}
    {!employment.length && <p className="text-14 text-muted">Add your first job. A job’s rows are used once they are confirmed.</p>}
    <button type="button" className="text-14 underline" onClick={() => onChange([...employment, { id: crypto.randomUUID(), company: "", jobTitle: "", startDate: "", endDate: "", current: false }])}>Add job</button>
  </section>;
}
