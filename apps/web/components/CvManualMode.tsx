"use client";

import { useEffect, useState } from "react";
import { inputSelection } from "@/lib/input-selection";
import { useRouter } from "next/navigation";
import type { CvContent } from "@col/core/cv";
import type { CvEditingTargets } from "@col/core/cv-editing-modes";
import type { CvTheme } from "@col/core/cv-theme-values";
import { createManualCvEdition, saveManualCvEdition } from "@/app/actions/cv-editing";
import { useCvContextLayout } from "./CvContextLayout";
import { SkillTagPicker, skillKey } from "./SkillTagPicker";
import { CvInlineWritingTool, type CvInlineQuotes } from "./CvInlineWritingTool";

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
export function CvManualMode({ contextId, descriptionVersionId, draft, prefill, copySource = null, initialTheme, skillChoices = [], inlineQuotes }: {
  contextId: string; descriptionVersionId: string | null; draft: Draft | null;
  prefill: { name: string; contact: string; summary: string };
  copySource?: { kind: "baseline" | "draft"; id: string } | null;
  initialTheme?: CvTheme;
  skillChoices?: readonly string[];
  inlineQuotes?: CvInlineQuotes;
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
  useCvContextLayout("manual", theme, setTheme, undefined, pending);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const stale = !!base && !!draft && draft.id !== base.id && draft.id !== expectedChild;
  const visibleSections = sections.map(row => ({ kind: row.kind, heading: row.heading,
    bullets: row.kind === "skill" ? row.skills.map(item => item.text) : row.bullets.map(item => item.text),
    signposts: row.kind === "skill" ? [] : row.bullets.map(item => item.signpost ?? null) }));
  const savedSections = base?.content?.sections.map(row => ({ kind: row.kind, heading: row.heading,
    bullets: row.kind === "skill" ? row.skillItems ?? [] : row.bullets,
    signposts: row.kind === "skill" ? [] : row.bullets.map((_, index) => row.bulletSignposts?.[index] ?? null) })) ?? [];
  const dirty = !!base && (name !== (base.content?.name ?? prefill.name) ||
    contact !== (base.content?.contact ?? prefill.contact) ||
    summary !== (base.content?.summary ?? prefill.summary) ||
    JSON.stringify(theme) !== JSON.stringify(initialTheme) ||
    JSON.stringify(visibleSections) !== JSON.stringify(savedSections));
  const inlineSource = base?.content && base.editingTargets
    ? { kind: "draft" as const, id: base.id, revision: base.revision } : null;
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
  async function save(change?: { type: "summary" | "section" | "bullet" | "skill";
    id: string; field: "text" | "signpost"; text: string }): Promise<boolean> {
    if (!base || stale || pending || expectedChild) return false;
    setPending(true); setError(null); setNotice(null);
    try {
      const nextSummary = change?.type === "summary" ? change.text : summary;
      const nextSections = change ? sections.map(row => ({ ...row,
        heading: change.type === "section" && row.sectionId === change.id ? change.text : row.heading,
        bullets: row.bullets.map(item => item.id === change.id && change.type === "bullet"
          ? change.field === "signpost" ? { ...item, signpost: change.text || null } : { ...item, text: change.text }
          : item),
        skills: row.skills.map(item => item.id === change.id && change.type === "skill" ? { ...item, text: change.text } : item),
      })) : sections;
      const content: CvContent = {
        ...(base.content ?? {}),
        ...(theme ? { theme } : {}),
        ...(base.content?.linkedinUrl ? { linkedinUrl: base.content.linkedinUrl } : {}),
        ...(base.content?.websiteUrl ? { websiteUrl: base.content.websiteUrl } : {}),
        name: name.trim(), contact: contact.trim(), summary: nextSummary.trim(), gaps: base.content?.gaps ?? [],
        sections: nextSections.map(row => {
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
            ...(row.original?.bulletSignposts || held.some(item => item.signpost) ?
              { bulletSignposts: held.map(item => item.signpost ?? null) } : {}),
            skillItems: undefined };
        }),
      };
      const targets = base.content ? { version: 1 as const,
        summaryId: base.editingTargets?.summaryId ?? uuid(),
        sections: nextSections.map(row => ({ entryId: row.entryId, sectionId: row.sectionId,
          bulletIds: row.kind === "skill" ? row.skills.flatMap((item, index) => item.text.trim() ? [row.mirroredBulletIds[index]!] : [])
            : row.bullets.filter(item => item.text.trim()).map(item => item.id),
          skillIds: row.kind === "skill" ? row.skills.filter(item => item.text.trim()).map(item => item.id) : [],
        })) } : undefined;
      const result = await saveManualCvEdition(base.id, base.revision, content, targets);
      if (!result.ok) { setError(result.error); return false; }
      setExpectedChild(result.draftId);
      setNotice(change ? "Change saved in this Manual CV." : "Manual wording saved as a new revision. No AI or role credit was used.");
      router.refresh(); return true;
    } catch { setError("Could not save Manual wording. Your edits are still here."); return false; }
    finally { setPending(false); }
  }
  return <div className="space-y-4 border border-line-muted p-4 text-14" data-cv-mode-dirty={dirty ? "true" : "false"}
    data-cv-mode-pending={pending || expectedChild ? "true" : "false"}
    data-cv-mode-editor-id={base?.id}>
    <div><h2 className="font-semibold">Manual · this version only</h2>
      <p className="text-12 text-muted">Write and save your own CV. Nothing here is added to Experience or remembered for Auto or Refine unless you explicitly choose it later.</p></div>
    {!base ? <div className="flex flex-wrap gap-2">
      {copySource && <button type="button" className="min-h-11 border border-line-muted px-4" disabled={pending || !descriptionVersionId}
        onClick={() => start(true)}>{pending ? "Starting…" : "Copy selected CV into Manual · free"}</button>}
      <button type="button" className="min-h-11 border border-line-muted px-4" disabled={pending || !descriptionVersionId}
        onClick={() => start(false)}>{pending ? "Starting…" : "Start blank Manual CV · free"}</button>
    </div> : <>
      {stale && <p role="alert" className="border border-warn p-3">The selected edition changed. Your typed wording remains here; copy it before reloading this application.</p>}
      {expectedChild && <p role="status">Updating the saved Manual CV… <button type="button" className="min-h-11 underline"
        onClick={() => router.refresh()}>Refresh saved CV</button></p>}
      <fieldset disabled={pending || !!expectedChild || stale} className="space-y-4">
      <label className="block space-y-1"><span className="font-medium">Name</span><input className="min-h-11 w-full border border-line-muted bg-raised px-3" maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label>
      <label className="block space-y-1"><span className="font-medium">Contact</span><input className="min-h-11 w-full border border-line-muted bg-raised px-3" maxLength={500} value={contact} onChange={event => setContact(event.target.value)} /></label>
      <div className="space-y-1" data-cv-source-summary="true"><label htmlFor="cv-manual-summary" className="block font-medium">Summary</label>
        <div className="flex flex-wrap items-start gap-2"><textarea id="cv-manual-summary" className="min-h-24 min-w-0 flex-1 border border-line-muted bg-raised p-3"
          value={summary} onChange={event => setSummary(event.target.value)} />
          {inlineQuotes && base?.editingTargets && <CvInlineWritingTool contextId={contextId} source={inlineSource}
            target={{ type: "summary", id: base.editingTargets.summaryId, field: "text" }} label="Summary"
            text={summary} quotes={inlineQuotes} getSelection={() => inputSelection("cv-manual-summary")}
            useLabel="Use change and save Manual CV"
            onUseChange={next => save({ type: "summary", id: base.editingTargets!.summaryId, field: "text", text: next })} />}</div></div>
      <div className="space-y-3"><h3 className="font-semibold">Sections</h3>
        {sections.map((row, index) => <fieldset key={row.sectionId} className="space-y-2 border border-line-muted p-3" data-cv-source-entry={row.entryId}>
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
          <div className="space-y-1"><label htmlFor={`cv-manual-heading-${row.sectionId}`} className="block">Heading</label>
            <div className="flex flex-wrap items-start gap-2"><input id={`cv-manual-heading-${row.sectionId}`}
              className="min-h-11 min-w-0 flex-1 border border-line-muted bg-raised px-3" maxLength={250}
              value={row.heading} onChange={event => updateSection(index, current => ({ ...current, heading: event.target.value }))} />
              {inlineQuotes && inlineSource && <CvInlineWritingTool contextId={contextId} source={inlineSource}
                target={{ type: "section", id: row.sectionId, field: "text" }} label={`${row.heading || `section ${index + 1}`} heading`}
                text={row.heading} quotes={inlineQuotes} getSelection={() => inputSelection(`cv-manual-heading-${row.sectionId}`)}
                useLabel="Use change and save Manual CV"
                onUseChange={next => save({ type: "section", id: row.sectionId, field: "text", text: next })} />}</div></div>
          {row.kind === "skill" && <SkillTagPicker label={`Choose skills for ${row.heading || `section ${index + 1}`}`}
            selected={row.skills.map(item => item.text).filter(Boolean)}
            choices={[...skillChoices, ...sections.flatMap(section => section.skills.map(item => item.text))]}
            limit={20} showSelected={false}
            onAdd={label => updateSection(index, current => skillKey(label) && !current.skills.some(item => skillKey(item.text) === skillKey(label))
              ? { ...current, skills: [...current.skills.filter(item => item.text.trim()), { id: uuid(), text: label }],
                mirroredBulletIds: [...current.skills.map((item, position) => item.text.trim() ? current.mirroredBulletIds[position] : null).filter((id): id is string => !!id), uuid()] }
              : current)}
            onRemove={() => {}} />}
          {(row.kind === "skill" ? row.skills : row.bullets).map((item, position) => <div key={item.id} className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap sm:items-start">
            <div className="col-span-3 w-full space-y-1 sm:min-w-0 sm:flex-1">
              {row.kind !== "skill" && <div className="flex flex-wrap items-start gap-2">
                <label className="min-w-0 flex-1 space-y-1"><span>Bullet title {position + 1} (optional)</span>
                  <input id={`cv-manual-title-${item.id}`} className="min-h-11 w-full border border-line-muted bg-raised px-3" maxLength={60}
                    value={item.signpost ?? ""} onChange={event => updateSection(index, current => ({ ...current,
                      bullets: current.bullets.map(value => value.id === item.id ? { ...value, signpost: event.target.value || null } : value) }))} /></label>
                {inlineQuotes && inlineSource && <CvInlineWritingTool contextId={contextId} source={inlineSource}
                  target={{ type: "bullet", id: item.id, field: "signpost" }} label={`Bullet title ${position + 1}`}
                  text={item.signpost ?? ""} quotes={inlineQuotes} getSelection={() => inputSelection(`cv-manual-title-${item.id}`)}
                  useLabel="Use change and save Manual CV"
                  onUseChange={next => save({ type: "bullet", id: item.id, field: "signpost", text: next })} />}</div>}
              <div className="flex flex-wrap items-start gap-2"><label className="min-w-0 flex-1 space-y-1">
                <span>{row.kind === "skill" ? `Skill ${position + 1}` : `Bullet ${position + 1}`}</span>
                <textarea id={`cv-manual-item-${item.id}`} className="min-h-11 w-full border border-line-muted bg-raised p-2" value={item.text}
                  onChange={event => updateItem(index, row.kind === "skill" ? "skills" : "bullets", item.id, event.target.value)} /></label>
                {inlineQuotes && inlineSource && <CvInlineWritingTool contextId={contextId} source={inlineSource}
                  target={{ type: row.kind === "skill" ? "skill" : "bullet", id: item.id, field: "text" }}
                  label={`${row.kind === "skill" ? "Skill" : "Bullet"} ${position + 1}`} text={item.text}
                  quotes={inlineQuotes} getSelection={() => inputSelection(`cv-manual-item-${item.id}`)}
                  useLabel="Use change and save Manual CV"
                  onUseChange={next => save({ type: row.kind === "skill" ? "skill" : "bullet", id: item.id, field: "text", text: next })} />}</div>
            </div>
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
        onClick={() => void save()}>{pending ? "Saving…" : "Save Manual CV · free"}</button>
      </fieldset>
    </>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="text-danger">{error}</p>}
  </div>;
}
