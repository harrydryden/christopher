"use client";
import { useActionState, useEffect, useState } from "react";
import { CvLibrarySchema, type CvLibrary } from "@christopher/core/cv";
import { saveCvLibrary } from "@/app/actions/cv";
import { useRouter } from "next/navigation";

const input = "w-full rounded border border-slate-300 p-2 text-sm dark:border-slate-700 dark:bg-slate-950";
const empty: CvLibrary = { name: "", contact: "", profile: "", entries: [] };
export function CvLibraryEditor({ library, version }: { library: CvLibrary | null; version: number }) {
  const router = useRouter();
  const [importError, setImportError] = useState("");
  const [value, setValue] = useState(library ?? empty);
  const [state, action, pending] = useActionState(saveCvLibrary, { ok: true } as Awaited<ReturnType<typeof saveCvLibrary>>);
  useEffect(() => { if (state.ok) router.refresh(); }, [state, router]);
  function field(key: "name" | "contact" | "profile", label: string, rows = 1) {
    return <label className="block space-y-1 text-sm"><span>{label}</span><textarea rows={rows} className={input} value={value[key]} onChange={e => setValue({ ...value, [key]: e.target.value })} /></label>;
  }
  return <form action={action} className="space-y-4">
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <label>Import library JSON<input type="file" accept="application/json,.json" className="ml-2" onChange={async e => {
        const file = e.target.files?.[0]; if (!file) return;
        try { if (file.size > 150000) throw new Error("Library file is too large"); setValue(CvLibrarySchema.parse(JSON.parse(await file.text()))); setImportError(""); }
        catch { setImportError("Could not import this library JSON. Check its format and size."); }
        e.target.value = "";
      }} /></label>
      <button type="button" className="underline" onClick={() => { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" })); const a = document.createElement("a"); a.href = url; a.download = "cv-library.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Export library</button>
    </div>
    {importError && <p role="alert" className="text-red-600">{importError}</p>}
    <input type="hidden" name="library" value={JSON.stringify(value)} /><input type="hidden" name="version" value={version} />
    {field("name", "Full name")}
    <label className="block space-y-1 text-sm">LinkedIn profile URL<input type="url" className={input} value={value.linkedinUrl ?? ""} placeholder="https://www.linkedin.com/in/your-profile" onChange={e => setValue({ ...value, linkedinUrl: e.target.value })} /></label>{field("contact", "Contact details (email, phone, location, links)")}{field("profile", "Career overview: facts the model may use", 4)}
    <p className="text-sm text-slate-500">Keep experience in reverse chronological order. Add achievements, numbers, skills and interests you can substantiate. Each draft keeps a snapshot of this evidence.</p>
    {value.entries.map((entry, i) => <fieldset key={entry.id} className="space-y-2 rounded border border-slate-200 p-3">
      <legend className="text-sm font-medium">Evidence {i + 1}</legend>
      <label className="block text-sm">Type <select aria-label={`Evidence ${i + 1} type`} className={input} value={entry.kind} onChange={e => setValue({ ...value, entries: value.entries.map((x, n) => n === i ? { ...x, kind: e.target.value as typeof entry.kind } : x) })}>{["experience", "education", "skill", "interest"].map(kind => <option key={kind}>{kind}</option>)}</select></label>
      <label className="block text-sm">Heading (role, employer and dates for experience)<input required className={input} value={entry.heading} onChange={e => setValue({ ...value, entries: value.entries.map((x, n) => n === i ? { ...x, heading: e.target.value } : x) })} /></label>
      <label className="block text-sm">Evidence and achievements<textarea required rows={5} className={input} value={entry.details} onChange={e => setValue({ ...value, entries: value.entries.map((x, n) => n === i ? { ...x, details: e.target.value } : x) })} /></label>
      <div className="flex gap-3">
      <button type="button" disabled={i === 0} className="text-sm underline disabled:opacity-40" onClick={() => { const entries = [...value.entries]; [entries[i - 1], entries[i]] = [entries[i]!, entries[i - 1]!]; setValue({ ...value, entries }); }}>Move up</button>
      <button type="button" disabled={i === value.entries.length - 1} className="text-sm underline disabled:opacity-40" onClick={() => { const entries = [...value.entries]; [entries[i], entries[i + 1]] = [entries[i + 1]!, entries[i]!]; setValue({ ...value, entries }); }}>Move down</button>
      <button type="button" className="text-sm underline" onClick={() => setValue({ ...value, entries: value.entries.filter((_, n) => n !== i) })}>Remove entry</button>
      </div>
    </fieldset>)}
    <button type="button" className="mr-4 text-sm underline" onClick={() => setValue({ ...value, entries: [...value.entries, { id: crypto.randomUUID(), kind: "experience", heading: "", details: "" }] })}>Add evidence</button>
    <button disabled={pending} className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50">{pending ? "Saving…" : "Save library"}</button>
    {!state.ok && <p role="alert" className="text-sm text-red-600">{state.error}</p>}
    <p className="text-xs text-slate-500">Saved library version: {version || "none"}. Changes to the library do not rewrite existing CVs.</p>
  </form>;
}
