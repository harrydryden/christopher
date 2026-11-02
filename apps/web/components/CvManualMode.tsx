"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { CvContent } from "@col/core/cv";
import type { CvEditingTargets } from "@col/core/cv-editing-modes";
import type { CvTheme } from "@col/core/cv-theme-values";
import { createManualCvEdition, saveManualCvEdition } from "@/app/actions/cv-editing";
import { CvAppearance } from "./CvAppearance";

type Kind = CvContent["sections"][number]["kind"];
type Item = { id: string; text: string; sources?: string[]; signpost?: string | null };
type Section = { entryId: string; sectionId: string; kind: Kind; heading: string;
  bullets: Item[]; skills: Item[]; mirroredBulletIds: string[];
  original: CvContent["sections"][number] | null };
type Draft = { id: string; revision: number; content: CvContent | null; editingTargets: CvEditingTargets | null };
const uuid = () => crypto.randomUUID();
const blank = (kind: Kind): Section => ({ entryId: `manual:${uuid()}`, sectionId: uuid(), kind, heading: "",
  bullets: kind === "skill" ? [] : [{ id: uuid(), text: "" }],
  skills: kind === "skill" ? [{ id: uuid(), text: "" }] : [],
  mirroredBulletIds: kind === "skill" ? [uuid()] : [], original: null });

function sectionsFrom(draft: Draft | null): Section[] {
  if (!draft?.content) return [];
  return draft.content.sections.map((section, index) => {
    const targets = draft.editingTargets?.sections[index];
    return { entryId: section.entryId, sectionId: targets?.sectionId ?? uuid(), kind: section.kind,
      heading: section.heading,
      bullets: section.kind === "skill" ? [] : section.bullets.map((text, i) => ({ id: targets?.bulletIds[i] ?? uuid(), text,
        sources: section.bulletSources?.[i], signpost: section.bulletSignposts?.[i] })),
      skills: (section.skillItems ?? []).map((text, i) => ({ id: targets?.skillIds[i] ?? uuid(), text,
        sources: section.bulletSources?.[i] })),
      mirroredBulletIds: section.kind === "skill" ? section.bullets.map((_, i) => targets?.bulletIds[i] ?? uuid()) : [],
      original: section,
    };
  });
}

/** A Manual edition starts empty and only becomes renderable after the person's first valid Save. */
export function CvManualMode({ contextId, descriptionVersionId, draft, prefill, copySource = null, initialTheme }: {
  contextId: string; descriptionVersionId: string | null; draft: Draft | null;
  prefill: { name: string; contact: string; summary: string };
  copySource?: { kind: "baseline" | "draft"; id: string } | null;
  initialTheme?: CvTheme;
}) {
  const router = useRouter();
  const [base, setBase] = useState<Draft | null>(draft);
  const [name, setName] = useState(draft?.content?.name ?? prefill.name);
  const [contact, setContact] = useState(draft?.content?.contact ?? prefill.contact);
  const [summary, setSummary] = useState(draft?.content?.summary ?? prefill.summary);
  const [theme, setTheme] = useState<CvTheme | undefined>(initialTheme);
  const [sections, setSections] = useState<Section[]>(() => sectionsFrom(draft));
  const [expectedChild, setExpectedChild] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const stale = !!base && !!draft && draft.id !== base.id && draft.id !== expectedChild;
  const visibleSections = sections.map(row => ({ kind: row.kind, heading: row.heading,
    bullets: row.kind === "skill" ? row.skills.map(item => item.text) : row.bullets.map(item => item.text) }));
  const savedSections = base?.content?.sections.map(row => ({ kind: row.kind, heading: row.heading,
    bullets: row.kind === "skill" ? row.skillItems ?? [] : row.bullets })) ?? [];
  const dirty = !!base && (name !== (base.content?.name ?? prefill.name) ||
    contact !== (base.content?.contact ?? prefill.contact) ||
    summary !== (base.content?.summary ?? prefill.summary) ||
    JSON.stringify(theme) !== JSON.stringify(initialTheme) ||
    JSON.stringify(visibleSections) !== JSON.stringify(savedSections));
  useEffect(() => {
    if (draft && expectedChild === draft.id) {
      setBase(draft); setSections(sectionsFrom(draft)); setName(draft.content?.name ?? prefill.name);
      setContact(draft.content?.contact ?? prefill.contact); setSummary(draft.content?.summary ?? prefill.summary);
      setTheme(initialTheme);
      setExpectedChild(null);
    }
  }, [draft, expectedChild, prefill.name, prefill.contact, prefill.summary, initialTheme]);

  async function start(copy: boolean) {
    if (!descriptionVersionId || pending) return;
    if (document.querySelector('[data-cv-mode-dirty="true"]') &&
      !window.confirm("Start another edition while another mode has unsaved wording? Your text remains on this page, but the selected edition will change.")) return;
    setPending(true); setError(null);
    try {
      const result = await createManualCvEdition(contextId, descriptionVersionId, copy ? copySource : null);
      if (!result.ok) setError(result.error);
      else { setExpectedChild(result.draftId); setNotice("Manual edition created. Add your own wording, then Save."); router.refresh(); }
    } catch { setError("Could not start Manual. Please try again."); }
    finally { setPending(false); }
  }
  function updateSection(index: number, edit: (row: Section) => Section) {
    setSections(rows => rows.map((row, i) => i === index ? edit(row) : row));
  }
  function updateItem(index: number, type: "bullets" | "skills", itemId: string, text: string) {
    updateSection(index, row => ({ ...row, [type]: row[type].map(item => item.id === itemId ? { ...item, text } : item) }));
  }
  async function save() {
    if (!base || stale || pending) return;
    setPending(true); setError(null); setNotice(null);
    try {
      const content: CvContent = {
        ...(base.content ?? {}),
        ...(theme ? { theme } : {}),
        ...(base.content?.linkedinUrl ? { linkedinUrl: base.content.linkedinUrl } : {}),
        ...(base.content?.websiteUrl ? { websiteUrl: base.content.websiteUrl } : {}),
        name: name.trim(), contact: contact.trim(), summary: summary.trim(), gaps: base.content?.gaps ?? [],
        sections: sections.map(row => {
          const heading = row.heading.trim();
          if (row.kind === "skill") {
            const held = row.skills.filter(item => item.text.trim());
            const skills = held.map(item => item.text.trim());
            return { ...(row.original ?? {}), entryId: row.entryId, kind: row.kind, heading,
              skillItems: skills, bullets: skills,
              ...(held.every(item => item.sources?.length) && held.length ? { bulletSources: held.map(item => item.sources!) } : { bulletSources: undefined }),
              bulletSignposts: undefined };
          }
          const held = row.bullets.filter(item => item.text.trim());
          return { ...(row.original ?? {}), entryId: row.entryId, kind: row.kind, heading,
            bullets: held.map(item => item.text.trim()),
            ...(held.every(item => item.sources?.length) && held.length ? { bulletSources: held.map(item => item.sources!) } : { bulletSources: undefined }),
            ...(row.original?.bulletSignposts ? { bulletSignposts: held.map(item => item.signpost ?? null) } : {}),
            skillItems: undefined };
        }),
      };
      const targets = base.content ? { version: 1 as const,
        summaryId: base.editingTargets?.summaryId ?? uuid(),
        sections: sections.map(row => ({ entryId: row.entryId, sectionId: row.sectionId,
          bulletIds: row.kind === "skill" ? row.skills.flatMap((item, index) => item.text.trim() ? [row.mirroredBulletIds[index]!] : [])
            : row.bullets.filter(item => item.text.trim()).map(item => item.id),
          skillIds: row.kind === "skill" ? row.skills.filter(item => item.text.trim()).map(item => item.id) : [],
        })) } : undefined;
      const result = await saveManualCvEdition(base.id, base.revision, content, targets);
      if (!result.ok) setError(result.error);
      else { setExpectedChild(result.draftId); setNotice("Manual wording saved as a new revision. No AI or CV credit was used."); router.refresh(); }
    } catch { setError("Could not save Manual wording. Your edits are still here."); }
    finally { setPending(false); }
  }
  return <div className="space-y-4 border border-line-muted p-4 text-14" data-cv-mode-dirty={dirty ? "true" : "false"}>
    <div><h2 className="font-semibold">Manual · this version only</h2>
      <p className="text-12 text-muted">Write and save your own CV. Nothing here is added to Experience or remembered for Auto or Refine unless you explicitly choose it later.</p></div>
    {!base ? <div className="flex flex-wrap gap-2">
      {copySource && <button type="button" className="min-h-11 border border-line-muted px-4" disabled={pending || !descriptionVersionId}
        onClick={() => start(true)}>{pending ? "Starting…" : "Copy selected CV into Manual · free"}</button>}
      <button type="button" className="min-h-11 border border-line-muted px-4" disabled={pending || !descriptionVersionId}
        onClick={() => start(false)}>{pending ? "Starting…" : "Start blank Manual CV · free"}</button>
    </div> : <>
      {stale && <p role="alert" className="border border-warn p-3">The selected edition changed. Your typed wording remains here; copy it before reloading this application.</p>}
      <label className="block space-y-1"><span className="font-medium">Name</span><input className="min-h-11 w-full border border-line-muted bg-raised px-3" maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label>
      <label className="block space-y-1"><span className="font-medium">Contact</span><input className="min-h-11 w-full border border-line-muted bg-raised px-3" maxLength={500} value={contact} onChange={event => setContact(event.target.value)} /></label>
      <label className="block space-y-1"><span className="font-medium">Summary</span><textarea className="min-h-24 w-full border border-line-muted bg-raised p-3" value={summary} onChange={event => setSummary(event.target.value)} /></label>
      {theme && <details className="border border-line-muted p-3"><summary className="cursor-pointer font-medium">Layout for this Manual edition</summary>
        <div className="mt-3"><CvAppearance value={theme} onChange={setTheme} /></div></details>}
      <div className="space-y-3"><h3 className="font-semibold">Sections</h3>
        {sections.map((row, index) => <fieldset key={row.sectionId} className="space-y-2 border border-line-muted p-3">
          <legend className="font-medium">Section {index + 1}</legend>
          <label className="block space-y-1"><span>Type</span><select className="min-h-11 w-full border border-line-muted bg-raised px-3" value={row.kind}
            disabled={!!row.original}
            onChange={event => updateSection(index, current => ({ ...current, kind: event.target.value as Kind,
              bullets: event.target.value === "skill" ? [] : current.bullets.length ? current.bullets : [{ id: uuid(), text: "" }],
              skills: event.target.value === "skill" ? current.skills.length ? current.skills : [{ id: uuid(), text: "" }] : [],
              mirroredBulletIds: event.target.value === "skill" ? current.mirroredBulletIds.length ? current.mirroredBulletIds : [uuid()] : [],
            }))}>
            {(["experience", "education", "training", "skill", "interest"] as const).map(kind => <option key={kind} value={kind}>{kind === "skill" ? "Skills" : kind[0]!.toUpperCase() + kind.slice(1)}</option>)}
          </select></label>
          <div className="flex flex-wrap gap-2"><button type="button" className="min-h-11 border border-line-muted px-3"
            aria-label={`Move section ${index + 1} up`} disabled={index === 0}
            onClick={() => setSections(rows => { const next = [...rows]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; return next; })}>↑</button>
            <button type="button" className="min-h-11 border border-line-muted px-3"
              aria-label={`Move section ${index + 1} down`} disabled={index === sections.length - 1}
              onClick={() => setSections(rows => { const next = [...rows]; [next[index], next[index + 1]] = [next[index + 1]!, next[index]!]; return next; })}>↓</button></div>
          <label className="block space-y-1"><span>Heading</span><input className="min-h-11 w-full border border-line-muted bg-raised px-3" maxLength={250}
            value={row.heading} onChange={event => updateSection(index, current => ({ ...current, heading: event.target.value }))} /></label>
          {(row.kind === "skill" ? row.skills : row.bullets).map((item, position) => <div key={item.id} className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap sm:items-start">
            <label className="col-span-3 w-full space-y-1 sm:min-w-0 sm:flex-1"><span>{row.kind === "skill" ? `Skill ${position + 1}` : `Bullet ${position + 1}`}</span>
              <textarea className="min-h-11 w-full border border-line-muted bg-raised p-2" value={item.text}
                onChange={event => updateItem(index, row.kind === "skill" ? "skills" : "bullets", item.id, event.target.value)} /></label>
            <button type="button" className="min-h-11 border border-line-muted px-3" aria-label={`Remove ${row.kind === "skill" ? "skill" : "bullet"} ${position + 1} from ${row.heading || `section ${index + 1}`}`}
              disabled={(row.kind === "skill" ? row.skills : row.bullets).length <= 1}
              onClick={() => updateSection(index, current => ({ ...current,
                [row.kind === "skill" ? "skills" : "bullets"]: (row.kind === "skill" ? current.skills : current.bullets).filter(value => value.id !== item.id),
                ...(row.kind === "skill" ? { mirroredBulletIds: current.mirroredBulletIds.filter((_, i) => i !== position) } : {}),
              }))}>Remove</button>
            <button type="button" className="min-h-11 border border-line-muted px-3" aria-label={`Move ${row.kind === "skill" ? "skill" : "bullet"} ${position + 1} up`}
              disabled={position === 0} onClick={() => updateSection(index, current => {
                const key = row.kind === "skill" ? "skills" : "bullets";
                const next = [...current[key]]; [next[position - 1], next[position]] = [next[position]!, next[position - 1]!];
                const mirroredBulletIds = [...current.mirroredBulletIds];
                if (row.kind === "skill") [mirroredBulletIds[position - 1], mirroredBulletIds[position]] = [mirroredBulletIds[position]!, mirroredBulletIds[position - 1]!];
                return { ...current, [key]: next, mirroredBulletIds };
              })}>↑</button>
            <button type="button" className="min-h-11 border border-line-muted px-3" aria-label={`Move ${row.kind === "skill" ? "skill" : "bullet"} ${position + 1} down`}
              disabled={position === (row.kind === "skill" ? row.skills : row.bullets).length - 1}
              onClick={() => updateSection(index, current => {
                const key = row.kind === "skill" ? "skills" : "bullets";
                const next = [...current[key]]; [next[position], next[position + 1]] = [next[position + 1]!, next[position]!];
                const mirroredBulletIds = [...current.mirroredBulletIds];
                if (row.kind === "skill") [mirroredBulletIds[position], mirroredBulletIds[position + 1]] = [mirroredBulletIds[position + 1]!, mirroredBulletIds[position]!];
                return { ...current, [key]: next, mirroredBulletIds };
              })}>↓</button>
          </div>)}
          <div className="flex flex-wrap gap-2"><button type="button" className="min-h-11 border border-line-muted px-3"
            onClick={() => updateSection(index, current => row.kind === "skill"
              ? { ...current, skills: [...current.skills, { id: uuid(), text: "" }], mirroredBulletIds: [...current.mirroredBulletIds, uuid()] }
              : { ...current, bullets: [...current.bullets, { id: uuid(), text: "" }] })}>Add {row.kind === "skill" ? "skill" : "bullet"}</button>
            <button type="button" className="min-h-11 border border-line-muted px-3" onClick={() => setSections(rows => rows.filter(value => value.sectionId !== row.sectionId))}>Remove section</button></div>
        </fieldset>)}
        <button type="button" className="min-h-11 border border-line-muted px-4" disabled={sections.length >= 20}
          onClick={() => setSections(rows => [...rows, blank("experience")])}>Add section</button>
      </div>
      {sections.some(row => !!row.original?.bulletSources &&
        !(row.kind === "skill" ? row.skills : row.bullets).filter(item => item.text.trim()).every(item => item.sources?.length)) &&
        <p className="text-12 text-warn">New lines cannot inherit old source citations. Save keeps your wording; its factual review will need a fresh Check.</p>}
      <button type="button" className="min-h-11 border border-line-muted px-4" disabled={pending || stale || !name.trim() || !summary.trim() || !sections.length}
        onClick={save}>{pending ? "Saving…" : "Save Manual CV · free"}</button>
    </>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="text-danger">{error}</p>}
  </div>;
}
