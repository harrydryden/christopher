"use client";
import { useEffect, useRef, useState } from "react";
import { CvContentSchema, cvDisplaySections, type CvContent } from "@christopher/core/cv";
import { saveCvDraft } from "@/app/actions/cv";
import { CvAppearance } from "./CvAppearance";
import { SettingsForm } from "./SettingsForm";

const input = "mt-1 block w-full rounded border border-slate-300 p-2 dark:border-slate-700 dark:bg-slate-950";
export function CvDraftEditor({ id, content }: { id: string; content: CvContent }) {
  const [summary, setSummary] = useState(content.summary);
  const [theme, setTheme] = useState(content.theme);
  const [rows, setRows] = useState(content.sections.map(section => (section.skillItems ?? section.bullets).join("\n")));
  const [preview, setPreview] = useState<{ url: string; fingerprint: string; pages: number }>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const candidate = { ...content, theme, summary, sections: content.sections.map((section, i) => ({ ...section, [section.skillItems ? "skillItems" : "bullets"]: rows[i]!.split("\n").map(row => row.trim()).filter(Boolean) })) };
  const fingerprint = JSON.stringify(candidate);
  const dirty = fingerprint !== JSON.stringify(content);
  const currentPreview = preview?.fingerprint === fingerprint;
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  useEffect(() => () => controller.current?.abort(), []);
  async function updatePreview() {
    const parsed = CvContentSchema.safeParse(candidate);
    if (!parsed.success) { setError(parsed.error.issues.map(issue => issue.message).join(" ")); return; }
    controller.current?.abort(); const request = new AbortController(); controller.current = request;
    setPending(true); setError("");
    try {
      const response = await fetch("/api/cv/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(parsed.data), signal: request.signal });
      if (!response.ok) throw new Error(await response.text());
      const url = URL.createObjectURL(await response.blob());
      if (request.signal.aborted) { URL.revokeObjectURL(url); return; }
      setPreview({ url, fingerprint, pages: Number(response.headers.get("x-cv-page-count")) });
    } catch (failure) { if (!request.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not render the PDF."); }
    finally { if (!request.signal.aborted) setPending(false); }
  }
  return <SettingsForm action={saveCvDraft.bind(null, id)} submitLabel="Save as new revision">
    <div className="rounded border border-slate-200 p-3 text-sm" role="status">{dirty ? "Unsaved changes. Preview these edits, then save a new revision to update the downloadable CV." : "Editing the saved revision. Appearance and wording are saved together."}</div>
    <section className="rounded-lg border border-slate-200 p-4"><h3 className="font-semibold">Appearance</h3>
      <div className="mt-3"><CvAppearance value={theme} onChange={setTheme} /></div>
      {!content.theme && <p className="mt-2 text-sm">This older CV keeps its original plain layout until you select a palette or change a layout control.</p>}
    </section>
    {theme && <input type="hidden" name="theme" value={JSON.stringify(theme)} />}
    <section className="space-y-3 rounded-lg border border-slate-200 p-4">
      <h2 className="font-semibold">Content</h2>
      <p className="text-sm">{content.name} · {content.contact}{content.linkedinUrl && <> · <a className="underline" href={content.linkedinUrl} target="_blank" rel="noopener noreferrer">LinkedIn</a></>}</p>
      <p className="text-xs text-slate-500">Identity and job headings come from the evidence snapshot. Edit the library and generate a new CV to change them.</p>
      <label className="block text-sm">Profile<textarea name="summary" maxLength={1800} value={summary} onChange={event => setSummary(event.target.value)} rows={5} className={input} /></label>
      {cvDisplaySections(content).map(({ section, index }) => <label key={section.entryId} className="block text-sm">
        <span className="font-semibold">{section.kind === "skill" ? "Skill" : section.heading}</span>
        {section.kind === "skill" && <span className="ml-2 text-xs text-slate-500">{section.heading}</span>}
        {!!section.industryDescriptions?.length && <span className="block text-xs text-slate-500">{section.industryDescriptions.join(" · ")}</span>}
        <textarea name={section.skillItems ? `skills-${index}` : `section-${index}`} value={rows[index]} onChange={event => setRows(previous => previous.map((row, i) => i === index ? event.target.value : row))} rows={section.skillItems ? 4 : Math.max(3, section.bullets.length * 2)} className={input} />
        <span className="text-xs text-slate-500">{section.skillItems ? "One skill per line, up to 20, with 80 characters per skill. Review any new claims." : section.kind === "skill" ? "Legacy skill prose. Add individual skills in the evidence library and generate a new CV to use pills." : "One bullet per line, up to six. Keep each under 650 characters."}</span>
      </label>)}
    </section>
    <section className="space-y-3 rounded-lg border border-slate-200 p-4">
      <h2 className="font-semibold">PDF preview</h2>
      <p className="text-sm">Render the current edits with the download renderer. This does not save a revision or call the writing model.</p>
      <button type="button" disabled={pending} onClick={updatePreview} className="rounded bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50">{pending ? "Rendering…" : "Preview current edits"}</button>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {preview && !currentPreview && <p role="status" className="text-sm">The content or appearance has changed. Refresh the preview to see these edits.</p>}
      {preview && currentPreview && <>
        <p className="text-sm" role="status">{preview.pages} {preview.pages === 1 ? "page" : "pages"}{preview.pages > 2 ? " — exceeds the two-page target. Shorten the content if needed; nothing has been clipped." : ""}. {dirty ? "Unsaved preview." : "Current revision preview."}</p>
        <a className="text-sm underline" href={preview.url} target="_blank" rel="noopener noreferrer">Open current preview</a>
        <iframe title="Current CV PDF preview" src={preview.url} className="h-[650px] w-full rounded border" />
      </>}
    </section>
    <label className="text-sm"><input type="checkbox" name="rememberWording" defaultChecked /> Remember wording corrections for future CVs. Palette changes apply only to this revision; change the library’s Appearance settings to set your default.</label>
  </SettingsForm>;
}
