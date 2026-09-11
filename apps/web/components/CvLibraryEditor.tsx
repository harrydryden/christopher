"use client";
import { useActionState, useEffect, useState } from "react";
import { CvLibrarySchema, consolidateExperience, employmentCompanyGroups, employmentHeading, responsibilityRows, updateResponsibilityRows, type CvLibrary } from "@christopher/core/cv";
import { saveCvLibrary } from "@/app/actions/cv";
import { EmploymentHistoryTable } from "./EmploymentHistoryTable";
import { useRouter } from "next/navigation";

const input = "w-full rounded border border-slate-300 p-2 text-sm dark:border-slate-700 dark:bg-slate-950";
const empty: CvLibrary = { name: "", contact: "", profile: "", employment: [], structuredExperience: true, entries: [] };
export function CvLibraryEditor({ library, version }: { library: CvLibrary | null; version: number }) {
  const router = useRouter();
  const [importError, setImportError] = useState("");
  const [value, setValue] = useState(() => library ? consolidateExperience(library) : empty);
  const [state, action, pending] = useActionState(saveCvLibrary, { ok: true } as Awaited<ReturnType<typeof saveCvLibrary>>);
  useEffect(() => { if (state.ok) router.refresh(); }, [state, router]);
  function statusControls(entry: CvLibrary["entries"][number]) {
    const status = entry.status ?? "active";
    return <div className="flex flex-wrap items-center gap-3 text-sm">
      <label>Status <select className={input} aria-label={`Status: ${entry.heading}`} value={status} onChange={event => setValue({ ...value, entries: value.entries.map(item => item.id === entry.id ? { ...item, status: event.target.value as "draft" | "active" | "inactive" } : item) })}>
        <option value="draft">Draft — excluded from CVs</option><option value="active">Active — eligible for CVs</option><option value="inactive">Inactive — archived</option>
      </select></label>
      {status !== "inactive" && <button type="button" className="underline" onClick={() => setValue({ ...value, entries: value.entries.map(item => item.id === entry.id ? { ...item, status: "inactive" } : item) })}>Archive block</button>}
      {status === "inactive" && <span>Archived. Select Draft or Active to restore this block.</span>}
    </div>;
  }
  function field(key: "name" | "contact" | "profile" | "stylePreferences" | "preferredWording", label: string, rows = 1) {
    return <label className="block space-y-1 text-sm"><span>{label}</span><textarea rows={rows} className={input} value={value[key] ?? ""} onChange={e => setValue({ ...value, [key]: e.target.value })} /></label>;
  }
  return <form action={action} className="space-y-4">
    <p className="text-sm">{version ? `Stored version ${version}: ${value.entries.length} evidence blocks. Edit any field below, then save a new version.` : "Your library is empty. Import your library JSON or add evidence below, then save."}</p>
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <label>Import library JSON<input type="file" accept="application/json,.json" className="ml-2" onChange={async e => {
        const file = e.target.files?.[0]; if (!file) return;
        try { if (file.size > 150000) throw new Error("Library file is too large"); setValue(consolidateExperience(CvLibrarySchema.parse(JSON.parse(await file.text())))); setImportError(""); }
        catch { setImportError("Could not import this library JSON. Check its format and size."); }
        e.target.value = "";
      }} /></label>
      <button type="button" className="underline" onClick={() => { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" })); const a = document.createElement("a"); a.href = url; a.download = "cv-library.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Export library</button>
    </div>
    {importError && <p role="alert" className="text-red-600">{importError}</p>}
    <input type="hidden" name="library" value={JSON.stringify(value)} /><input type="hidden" name="version" value={version} />
    <EmploymentHistoryTable employment={value.employment ?? []} entries={value.entries} onChange={employment => setValue({ ...value, employment })} />
    {field("name", "Full name")}
    <label className="block space-y-1 text-sm">LinkedIn profile URL<input type="url" className={input} value={value.linkedinUrl ?? ""} placeholder="https://www.linkedin.com/in/your-profile" onChange={e => setValue({ ...value, linkedinUrl: e.target.value })} /></label>{field("contact", "Contact details (email, phone, location, links)")}{field("profile", "Career overview: facts the model may use", 4)}
    {field("stylePreferences", "Preferred CV style (tone, length and wording to avoid)", 3)}
    {field("preferredWording", "Remembered wording corrections (review, edit or remove)", 5)}
    <p className="text-sm text-slate-500">Only Active blocks are used in new CVs. For experience, tick Confirmed beside each responsibility or outcome you can substantiate. Unconfirmed rows are excluded from CVs and role qualification. Editing a row requires confirmation again. New blocks start as Draft; archiving makes them Inactive. Save your library before generating a CV. Existing CVs keep their original evidence snapshot.</p>
    <h2 className="text-lg font-semibold">Evidence blocks</h2>
    {employmentCompanyGroups(value.employment ?? []).map(group => <section key={group.company.toLowerCase()} className="space-y-3">
      <h3 className="text-lg font-semibold">{group.company || "New company"}</h3>
      {group.jobs.map(job => {
        const entry = value.entries.find(item => item.kind === "experience" && item.employmentId === job.id);
        const rows = entry ? entry.details.split("\n") : [];
        function updateRows(next: string[]) {
          setValue({ ...value, entries: entry ? value.entries.map(item => item.id === entry.id ? updateResponsibilityRows(item, next) : item) : [...value.entries, { id: crypto.randomUUID(), kind: "experience", status: "draft", employmentId: job.id, heading: employmentHeading(job) || "New job", details: next.join("\n"), confirmedResponsibilities: [] }] });
        }
        return <fieldset key={job.id} className="space-y-3 rounded border border-slate-300 p-3">
          <legend className="font-medium">{employmentHeading(job) || "Complete this job in employment history"}</legend>
          {entry && statusControls(entry)}
          <p className="text-sm">Responsibilities and outcomes · {rows.length}/20 · {rows.filter(row => entry?.confirmedResponsibilities?.includes(responsibilityRows(row)[0] ?? "")).length} confirmed</p>
          {rows.length > 20 && <p role="alert" className="text-sm text-amber-700">All existing wording has been preserved. Combine related rows to reach 20 or fewer before saving.</p>}
          <div className="overflow-x-auto"><table className="w-full text-left text-sm" aria-label={`${job.company} ${job.jobTitle} responsibilities and outcomes`}>
            <thead><tr className="border-b border-slate-300 dark:border-slate-700"><th scope="col" className="w-10 p-2">#</th><th scope="col" className="w-28 p-2 text-center">Confirmed</th><th scope="col" className="p-2">Narrative</th></tr></thead>
            <tbody>{rows.map((row, index) => <tr key={index} className="border-b border-slate-200 align-top dark:border-slate-800">
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
            <button type="button" className="mt-2 text-sm underline" aria-label={`Remove ${job.company} ${job.jobTitle} entry ${index + 1}`} onClick={() => {
              if (rows.length === 1 && entry) setValue({ ...value, entries: entry.details.trim() ? value.entries.map(item => item.id === entry.id ? { ...item, status: "inactive" } : item) : value.entries.filter(item => item.id !== entry.id) });
              else updateRows(rows.filter((_, position) => position !== index));
            }}>Remove</button>
              </div></td>
            </tr>)}</tbody>
          </table></div>
          <button type="button" className="text-sm underline disabled:opacity-40" disabled={rows.length >= 20} onClick={() => updateRows([...rows, ""])}>Add new responsibility or outcome</button>
        </fieldset>;
      })}
    </section>)}
    <h3 className="text-lg font-semibold">Education, skills and interests</h3>
    {value.entries.map((entry, i) => entry.kind === "experience" ? null : <fieldset key={entry.id} className="space-y-2 rounded border border-slate-200 p-3">
      <legend className="text-sm font-medium">Evidence {i + 1}</legend>
      {statusControls(entry)}
      <label className="block text-sm">Type <select aria-label={`Evidence ${i + 1} type`} className={input} value={entry.kind} onChange={e => setValue({ ...value, entries: value.entries.map((x, n) => n === i ? { ...x, kind: e.target.value as typeof entry.kind, employmentId: undefined } : x) })}>{["education", "skill", "interest"].map(kind => <option key={kind}>{kind}</option>)}</select></label>
      <label className="block text-sm">Evidence label (for example: AI governance programme)<input required className={input} value={entry.heading} onChange={e => setValue({ ...value, entries: value.entries.map((x, n) => n === i ? { ...x, heading: e.target.value } : x) })} /></label>
      <label className="block text-sm">Details<textarea required rows={5} className={input} value={entry.details} onChange={e => setValue({ ...value, entries: value.entries.map((x, n) => n === i ? { ...x, details: e.target.value } : x) })} /></label>
      <div className="flex gap-3">
      <button type="button" disabled={i === 0} className="text-sm underline disabled:opacity-40" onClick={() => { const entries = [...value.entries]; [entries[i - 1], entries[i]] = [entries[i]!, entries[i - 1]!]; setValue({ ...value, entries }); }}>Move up</button>
      <button type="button" disabled={i === value.entries.length - 1} className="text-sm underline disabled:opacity-40" onClick={() => { const entries = [...value.entries]; [entries[i], entries[i + 1]] = [entries[i + 1]!, entries[i]!]; setValue({ ...value, entries }); }}>Move down</button>
      </div>
    </fieldset>)}
    <button type="button" className="mr-4 text-sm underline" onClick={() => setValue({ ...value, entries: [...value.entries, { id: crypto.randomUUID(), kind: "skill", status: "draft", heading: "", details: "" }] })}>Add education, skill or interest</button>
    <button disabled={pending} className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50">{pending ? "Saving…" : "Save library"}</button>
    {!state.ok && <p role="alert" className="text-sm text-red-600">{state.error}</p>}
    <p className="text-xs text-slate-500">Saved library version: {version || "none"}. Changes to the library do not rewrite existing CVs.</p>
  </form>;
}
