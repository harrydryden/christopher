"use client";
import { useActionState, useEffect, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { CvLibrarySchema, consolidateExperience, employmentCompanyGroups, employmentHeading, responsibilityRows, updateResponsibilityRows, type CvLibrary } from "@christopher/core/cv";
import { saveCvLibrary } from "@/app/actions/cv";
import { EmploymentHistoryTable } from "./EmploymentHistoryTable";
import { useRouter } from "next/navigation";
import { buttonClass } from "@/components/Button";
import { inputClass, labelClass, selectClass } from "@/components/Field";

const input = inputClass;
const libraryTabs = [["intro", "Intro"], ["experience", "Experience"], ["education", "Education, skills and interests"]] as const;
type LibraryTab = typeof libraryTabs[number][0];
const empty: CvLibrary = { name: "", contact: "", profile: "", employment: [], structuredExperience: true, entries: [] };
export function CvLibraryEditor({ library, version }: { library: CvLibrary | null; version: number }) {
  const router = useRouter();
  const [tab, setTab] = useState<LibraryTab>("intro");
  const [importError, setImportError] = useState("");
  const [value, setValue] = useState(() => library ? consolidateExperience(library) : empty);
  const [state, action, pending] = useActionState(saveCvLibrary, { ok: true } as Awaited<ReturnType<typeof saveCvLibrary>>);
  useEffect(() => { if (state.ok) router.refresh(); }, [state, router]);
  function revealInvalidField(event: FormEvent<HTMLDivElement>, panel: LibraryTab) {
    event.preventDefault();
    flushSync(() => setTab(panel));
    (event.target as HTMLElement).focus();
  }
  function statusControls(entry: CvLibrary["entries"][number]) {
    const status = entry.status ?? "active";
    return <div className="flex flex-wrap items-center gap-3 text-14">
      <label className="flex items-center gap-2">Status <select className={`w-auto ${selectClass}`} aria-label={`Status: ${entry.heading}`} value={status} onChange={event => setValue({ ...value, entries: value.entries.map(item => item.id === entry.id ? { ...item, status: event.target.value as "draft" | "active" | "inactive" } : item) })}>
        <option value="draft">Draft — excluded from CVs</option><option value="active">Active — eligible for CVs</option><option value="inactive">Inactive — archived</option>
      </select></label>
      {status !== "inactive" && <button type="button" className="underline" onClick={() => setValue({ ...value, entries: value.entries.map(item => item.id === entry.id ? { ...item, status: "inactive" } : item) })}>Archive block</button>}
      {status === "inactive" && <span>Archived. Select Draft or Active to restore this block.</span>}
    </div>;
  }
  function field(key: "name" | "contact" | "profile", label: string, rows = 1) {
    return <label className="block space-y-1.5 text-14"><span className={labelClass}>{label}</span><textarea rows={rows} className={`resize-y ${input}`} value={value[key] ?? ""} onChange={e => setValue({ ...value, [key]: e.target.value })} /></label>;
  }
  return <form action={action} className="space-y-4">
    <div className="flex flex-wrap items-center gap-3 text-14">
      <label className="flex flex-wrap items-center gap-2"><span className={labelClass}>Import library JSON</span><input type="file" accept="application/json,.json" className="ds-pixel max-w-full text-10 file:mr-2 file:cursor-pointer file:border-2 file:border-line file:bg-raised file:px-2.5 file:py-1 file:text-10 file:text-fg hover:file:bg-fg hover:file:text-bg" onChange={async e => {
        const file = e.target.files?.[0]; if (!file) return;
        try { if (file.size > 150000) throw new Error("Library file is too large"); setValue(consolidateExperience(CvLibrarySchema.parse(JSON.parse(await file.text())))); setImportError(""); }
        catch { setImportError("Could not import this library JSON. Check its format and size."); }
        e.target.value = "";
      }} /></label>
      <button type="button" className="underline" onClick={() => { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" })); const a = document.createElement("a"); a.href = url; a.download = "cv-library.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Export library</button>
    </div>
    {importError && <p role="alert" className="text-danger">{importError}</p>}
    <input type="hidden" name="library" value={JSON.stringify(value)} /><input type="hidden" name="version" value={version} />
    <div role="tablist" aria-label="Library sections" className="flex gap-2 border-b border-line-muted">
      {libraryTabs.map(([id, label]) => <button
        key={id} type="button" role="tab" id={`library-tab-${id}`} aria-controls={`library-panel-${id}`}
        aria-selected={tab === id} tabIndex={tab === id ? 0 : -1}
        className={`ds-pixel border-b-2 px-4 py-3 text-11 ${tab === id ? 'border-line text-fg' : 'border-transparent text-muted hover:text-fg'}`}
        onClick={() => setTab(id)} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const index = libraryTabs.findIndex(([key]) => key === id);
          const next = libraryTabs[event.key === 'Home' ? 0 : event.key === 'End' ? libraryTabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + libraryTabs.length) % libraryTabs.length]![0];
          setTab(next);
          document.getElementById(`library-tab-${next}`)?.focus();
        }}>{label}</button>)}
    </div>
    <div role="tabpanel" id="library-panel-intro" aria-labelledby="library-tab-intro" hidden={tab !== 'intro'} className="space-y-4" onInvalidCapture={event => revealInvalidField(event, 'intro')}>
    {field("name", "Name")}
    <label className="block space-y-1.5 text-14"><span className={labelClass}>LinkedIn</span><input type="url" className={input} value={value.linkedinUrl ?? ""} placeholder="https://www.linkedin.com/in/your-profile" onChange={e => setValue({ ...value, linkedinUrl: e.target.value })} /></label>
    <label className="block space-y-1.5 text-14"><span className={labelClass}>Website</span><input type="url" className={input} value={value.websiteUrl ?? ""} placeholder="https://example.com" onChange={e => setValue({ ...value, websiteUrl: e.target.value })} /></label>
    {field("contact", "Contact details")}{field("profile", "Career overview", 4)}
    </div>
    <div role="tabpanel" id="library-panel-experience" aria-labelledby="library-tab-experience" hidden={tab !== 'experience'} className="space-y-4" onInvalidCapture={event => revealInvalidField(event, 'experience')}>
    <EmploymentHistoryTable employment={value.employment ?? []} entries={value.entries} onChange={employment => setValue({ ...value, employment })} />
    <h2 className="text-16 font-semibold">Experience</h2>
    {employmentCompanyGroups(value.employment ?? []).map(group => <section key={group.company.toLowerCase()} className="space-y-3">
      <h3 className="text-16 font-semibold">{group.company || "New company"}</h3>
      {group.jobs.map(job => {
        const entry = value.entries.find(item => item.kind === "experience" && item.employmentId === job.id);
        const rows = entry ? entry.details.split("\n") : [];
        function updateRows(next: string[]) {
          setValue({ ...value, entries: entry ? value.entries.map(item => item.id === entry.id ? updateResponsibilityRows(item, next) : item) : [...value.entries, { id: crypto.randomUUID(), kind: "experience", status: "draft", employmentId: job.id, heading: employmentHeading(job) || "New job", details: next.join("\n"), confirmedResponsibilities: [] }] });
        }
        return <fieldset key={job.id} className="space-y-3 border border-line-muted p-3">
          <legend className="font-medium">{employmentHeading(job) || "Complete this job in employment history"}</legend>
          {entry && statusControls(entry)}
          <p className="text-14">Responsibilities and outcomes · {rows.length}/20 · {rows.filter(row => entry?.confirmedResponsibilities?.includes(responsibilityRows(row)[0] ?? "")).length} confirmed</p>
          {rows.length > 20 && <p role="alert" className="text-14 text-warn">All existing wording has been preserved. Combine related rows to reach 20 or fewer before saving.</p>}
          <div className="overflow-x-auto"><table className="w-full text-left text-14" aria-label={`${job.company} ${job.jobTitle} responsibilities and outcomes`}>
            <thead><tr className="border-b border-line-muted"><th scope="col" className="w-10 p-2">#</th><th scope="col" className="w-28 p-2 text-center">Confirmed</th><th scope="col" className="p-2">Narrative</th></tr></thead>
            <tbody>{rows.map((row, index) => <tr key={index} className="border-b border-line-muted align-top">
              <th scope="row" className="p-2 pt-4 font-normal">{index + 1}</th>
              <td className="p-2 pt-4 text-center"><input type="checkbox" className="h-4 w-4 accent-emerald-600" aria-label={`Confirm ${job.company} ${job.jobTitle} entry ${index + 1}`} disabled={!row.trim()} checked={entry?.confirmedResponsibilities?.includes(responsibilityRows(row)[0] ?? "") ?? false} onChange={event => {
                  const text = responsibilityRows(row)[0];
                  if (!entry || !text) return;
                  const confirmed = new Set(entry.confirmedResponsibilities ?? []);
                  if (event.target.checked) confirmed.add(text); else confirmed.delete(text);
                  setValue({ ...value, entries: value.entries.map(item => item.id === entry.id ? { ...item, confirmedResponsibilities: [...confirmed] } : item) });
                }} /></td>
              <td className="p-2"><div className="flex items-start gap-2">
              <textarea required rows={2} className={input} aria-label={`${job.company} ${job.jobTitle} responsibility ${index + 1}`} value={row} onChange={event => updateRows(rows.map((text, position) => position === index ? event.target.value.replace(/\r?\n/g, " ") : text))} />
            <button type="button" className="mt-2 text-14 underline" aria-label={`Remove ${job.company} ${job.jobTitle} entry ${index + 1}`} onClick={() => {
              if (rows.length === 1 && entry) setValue({ ...value, entries: entry.details.trim() ? value.entries.map(item => item.id === entry.id ? { ...item, status: "inactive" } : item) : value.entries.filter(item => item.id !== entry.id) });
              else updateRows(rows.filter((_, position) => position !== index));
            }}>Remove</button>
              </div></td>
            </tr>)}</tbody>
          </table></div>
          <button type="button" className="text-14 underline disabled:opacity-40" disabled={rows.length >= 20} onClick={() => updateRows([...rows, ""])}>Add new responsibility or outcome</button>
        </fieldset>;
      })}
    </section>)}
    </div>
    <div role="tabpanel" id="library-panel-education" aria-labelledby="library-tab-education" hidden={tab !== 'education'} className="space-y-4" onInvalidCapture={event => revealInvalidField(event, 'education')}>
    <h2 className="text-16 font-semibold">Education, skills and interests</h2>
    {value.entries.map((entry, i) => entry.kind === "experience" ? null : <fieldset key={entry.id} className="space-y-2 border border-line-muted p-3">
      <legend className="text-14 font-medium">Evidence {i + 1}</legend>
      {statusControls(entry)}
      <label className="block text-14">Type <select aria-label={`Evidence ${i + 1} type`} className={input} value={entry.kind} onChange={e => setValue({ ...value, entries: value.entries.map((x, n) => n === i ? { ...x, kind: e.target.value as typeof entry.kind, skillItems: e.target.value === "skill" ? x.skillItems : undefined, employmentId: undefined } : x) })}>{["education", "skill", "interest"].map(kind => <option key={kind}>{kind}</option>)}</select></label>
      <label className="block text-14">Evidence label (for example: AI governance programme)<input required className={input} value={entry.heading} onChange={e => setValue({ ...value, entries: value.entries.map((x, n) => n === i ? { ...x, heading: e.target.value } : x) })} /></label>
      {entry.kind === "skill" && <label className="block space-y-1 text-14">Individual skills — one per line
        <textarea rows={4} className={input} aria-label={`Individual skills: ${entry.heading}`} onBlur={() => setValue(current => ({ ...current, entries: current.entries.map(item => item.id === entry.id ? { ...item, skillItems: item.skillItems?.map(skill => skill.trim()).filter(Boolean).length ? item.skillItems.map(skill => skill.trim()).filter(Boolean) : undefined } : item) }))} value={entry.skillItems?.join("\n") ?? ""} onChange={e => setValue({ ...value, entries: value.entries.map((x, n) => n === i ? { ...x, skillItems: e.target.value ? e.target.value.split("\n") : undefined } : x) })} />
        <span className="block text-12 text-muted">Up to 20 skills, 80 characters each. Enter labels explicitly; existing prose is not split automatically. Leave blank to retain prose rendering. The supporting details below remain evidence.</span>
      </label>}
      <label className="block text-14">Details<textarea required rows={5} className={input} value={entry.details} onChange={e => setValue({ ...value, entries: value.entries.map((x, n) => n === i ? { ...x, details: e.target.value } : x) })} /></label>
      <div className="flex gap-3">
      <button type="button" disabled={i === 0} className="text-14 underline disabled:opacity-40" onClick={() => { const entries = [...value.entries]; [entries[i - 1], entries[i]] = [entries[i]!, entries[i - 1]!]; setValue({ ...value, entries }); }}>Move up</button>
      <button type="button" disabled={i === value.entries.length - 1} className="text-14 underline disabled:opacity-40" onClick={() => { const entries = [...value.entries]; [entries[i], entries[i + 1]] = [entries[i + 1]!, entries[i]!]; setValue({ ...value, entries }); }}>Move down</button>
      </div>
    </fieldset>)}
    <button type="button" className="mr-4 text-14 underline" onClick={() => setValue({ ...value, entries: [...value.entries, { id: crypto.randomUUID(), kind: "skill", status: "draft", heading: "", details: "" }] })}>Add education, skill or interest</button>
    </div>
    <button disabled={pending} className={buttonClass("primary")}>{pending ? "Saving…" : "Save library"}</button>
    {!state.ok && <p role="alert" className="text-14 text-danger">{state.error}</p>}
  </form>;
}
