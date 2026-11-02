"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { CvRefinementConflict, CvRefinementV1 } from "@col/core/cv-editing-modes";
import type { CvEditingTargets } from "@col/core/cv-editing-modes";
import type { CvContent } from "@col/core/cv";
import type { CvTargetingChoices, CvTargetingView } from "@col/core/cv-targeting";
import type { CvTheme } from "@col/core/cv-theme-values";
import { CvAppearance } from "./CvAppearance";
import { CvTargetingControls, initialCvTargetingChoices, cvTargetingChoiceIssue } from "./CvTargetingPanel";
import { generateRefinedCv, resetCvRefinement, saveCvRefinement } from "@/app/actions/cv-editing";

export type RefinementTargetOption = { type: CvRefinementV1["target"]["type"]; id?: string; label: string; sourceText: string };

export function CvRefineMode({ contextId, source: incomingSource, initialVersion, targets: incomingTargets, refinements,
  sourceContent: incomingContent = null, sourceTargets: incomingSourceTargets = null,
  targetingView: incomingTargetingView = null, sourceTheme: incomingTheme, conflicts = [] }: {
  contextId: string; source: { kind: "baseline" | "draft"; id: string; label: string; autoOrigin?: boolean } | null;
  initialVersion: number; targets: RefinementTargetOption[]; refinements: CvRefinementV1[];
  sourceContent?: CvContent | null; sourceTargets?: CvEditingTargets | null; targetingView?: CvTargetingView | null;
  sourceTheme?: CvTheme;
  conflicts?: CvRefinementConflict[];
}) {
  const router = useRouter();
  const [base, setBase] = useState(() => ({ source: incomingSource, targets: incomingTargets,
    sourceContent: incomingContent, sourceTargets: incomingSourceTargets,
    targetingView: incomingTargetingView, sourceTheme: incomingTheme }));
  const { source, targets, sourceContent, sourceTargets, targetingView, sourceTheme } = base;
  const [version, setVersion] = useState(initialVersion);
  const [targetIndex, setTargetIndex] = useState(0);
  const [kind, setKind] = useState<"exact_wording" | "instruction">("exact_wording");
  const [text, setText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [focus, setFocus] = useState<"wording" | "targeting" | "appearance" | "order">("wording");
  const [choices, setChoices] = useState<CvTargetingChoices | null>(() => targetingView ? initialCvTargetingChoices(targetingView) : null);
  const [appearance, setAppearance] = useState<CvTheme | null>(sourceTheme ?? null);
  const [sectionOrder, setSectionOrder] = useState<string[]>(() => sourceTargets?.sections.map(row => row.sectionId) ?? []);
  const [itemOrder, setItemOrder] = useState<Record<string, string[]>>(() => Object.fromEntries(
    sourceTargets?.sections.filter((_, index) => sourceContent?.sections[index]?.kind === "skill")
      .map(row => [row.sectionId, row.skillIds]) ?? []));
  const [structureDirty, setStructureDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const target = targets[targetIndex];
  const needsNewGeneration = !(source?.kind === "baseline" || source?.autoOrigin) ||
    refinements.some(row => row.kind === "instruction");
  const sourceChanged = incomingSource?.id !== source?.id || incomingSource?.kind !== source?.kind;
  useEffect(() => {
    if (!sourceChanged || text.trim() || structureDirty || editingId) return;
    setBase({ source: incomingSource, targets: incomingTargets, sourceContent: incomingContent,
      sourceTargets: incomingSourceTargets, targetingView: incomingTargetingView, sourceTheme: incomingTheme });
    setTargetIndex(0); setChoices(incomingTargetingView ? initialCvTargetingChoices(incomingTargetingView) : null);
    setAppearance(incomingTheme ?? null);
    setSectionOrder(incomingSourceTargets?.sections.map(row => row.sectionId) ?? []);
    setItemOrder(Object.fromEntries(incomingSourceTargets?.sections.filter((_, index) =>
      incomingContent?.sections[index]?.kind === "skill").map(row => [row.sectionId, row.skillIds]) ?? []));
  }, [sourceChanged, incomingSource, incomingTargets, incomingContent, incomingSourceTargets,
    incomingTargetingView, incomingTheme, text, structureDirty, editingId]);

  async function save() {
    if (!source || !target || pending || sourceChanged) return;
    setPending(true); setError(null); setNotice(null);
    try {
      const result = await saveCvRefinement(contextId, version, { kind,
        ...(editingId ? { id: editingId } : {}),
        target: { type: target.type, ...(target.id ? { id: target.id } : {}) }, text,
        order: editingId ? refinements.find(row => row.id === editingId)?.order ?? refinements.length : refinements.length,
        sourceKind: source.kind, sourceId: source.id });
      if (!result.ok) setError(result.error);
      else { setVersion(result.version); setText(""); setEditingId(null); setNotice("Refinement saved for this application."); router.refresh(); }
    } catch { setError("Could not save this refinement. Your wording is still here."); }
    finally { setPending(false); }
  }
  async function saveStructure() {
    if (!source || pending || sourceChanged) return;
    const structured: CvRefinementV1["structured"] = focus === "targeting" && choices ? { kind: "targeting", choices }
      : focus === "appearance" && appearance ? { kind: "appearance", theme: appearance }
        : focus === "order" && sourceTargets ? { kind: "item_order", sectionIds: sectionOrder, itemIds: itemOrder }
          : undefined;
    if (!structured) return;
    const issue = focus === "targeting" && targetingView && choices ? cvTargetingChoiceIssue(targetingView, choices) : null;
    if (issue) { setError(issue); return; }
    setPending(true); setError(null); setNotice(null);
    try {
      const result = await saveCvRefinement(contextId, version, {
        ...(editingId ? { id: editingId } : {}), kind: "structured",
        target: { type: focus === "appearance" ? "appearance" : "selection" }, structured,
        order: editingId ? refinements.find(row => row.id === editingId)?.order ?? refinements.length : refinements.length,
        sourceKind: source.kind, sourceId: source.id,
      });
      if (!result.ok) setError(result.error);
      else { setVersion(result.version); setEditingId(null); setStructureDirty(false);
        setNotice("This choice is remembered for this application."); router.refresh(); }
    } catch { setError("Could not save this choice. It remains here for you to retry."); }
    finally { setPending(false); }
  }
  function edit(row: CvRefinementV1) {
    setEditingId(row.id);
    setStructureDirty(false);
    if (row.kind === "structured") {
      if (row.structured?.kind === "targeting") { setFocus("targeting"); setChoices(row.structured.choices); }
      if (row.structured?.kind === "appearance") { setFocus("appearance"); setAppearance(row.structured.theme); }
      if (row.structured?.kind === "item_order") { setFocus("order"); setSectionOrder(row.structured.sectionIds); setItemOrder(row.structured.itemIds); }
    } else {
      setFocus("wording"); setKind(row.kind);
      setTargetIndex(Math.max(0, targets.findIndex(option => option.type === row.target.type && option.id === row.target.id)));
      setText(row.text ?? "");
    }
  }
  async function reset(id?: string) {
    if (pending) return;
    setPending(true); setError(null); setNotice(null);
    try {
      const result = await resetCvRefinement(contextId, version, id);
      if (!result.ok) setError(result.error);
      else { setVersion(result.version);
        setNotice(id ? "One rule reset. Apply the remaining refinements to create a new saved result."
          : "All refinements reset. The clean Auto result is selected again; prior saved editions remain in history.");
        router.refresh(); }
    } catch { setError("Could not reset the refinement. Please try again."); }
    finally { setPending(false); }
  }
  async function generate() {
    if (!source || !refinements.length || pending || sourceChanged) return;
    if (conflicts.length) { setError("Resolve or reset the marked refinements before generating."); return; }
    if (text.trim() || structureDirty) { setError("Save your current changes before generating. They are still here."); return; }
    if (document.querySelector('[data-cv-mode-dirty="true"]') &&
      !window.confirm("Apply saved refinements while another mode has unsaved wording? Your text remains on this page, but the selected edition may change.")) return;
    setPending(true); setError(null); setNotice(null);
    try {
      const result = await generateRefinedCv(contextId, version, source.kind, source.id);
      if (!result.ok) setError(result.error);
      else {
        setNotice(result.status === "ready" ? "Refined CV ready. No new CV credit was used."
          : result.status === "queued" ? "Refined CV queued. Your current selection stays available while it builds."
            : "This refinement could not be completed. Your saved instructions remain available.");
        router.refresh();
      }
    } catch { setError("Could not start this refinement. Your saved instructions remain available."); }
    finally { setPending(false); }
  }

  return <div className="space-y-4 border border-line-muted p-4 text-14" data-cv-mode-dirty={text.trim() || structureDirty ? "true" : "false"}>
    <div><h2 className="font-semibold">Refine this application</h2>
      <p className="text-12 text-muted">Remember only edits you choose for this role. A Manual edition can be a comparison source; none of its wording is promoted automatically.</p></div>
    {!source || !targets.length ? <p>Choose a saved Auto or Manual edition with stable text targets to start refining.</p> : <>
      <p className="text-12 text-muted">Comparing with: {source.label}</p>
      {sourceChanged && <p role="alert" className="border border-warn p-3 text-14">The selected edition changed while this refinement buffer was open. Your wording remains here for its original source. Re-select that source from history to save it, or copy the text before reloading.</p>}
      <div role="group" aria-label="Refinement type" className="flex flex-wrap gap-2">
        {([ ["wording", "Wording or instruction"], ["targeting", "Role priorities and evidence"],
          ["appearance", "Layout"], ["order", "Section and skill order"] ] as const).map(([value, label]) =>
          <button key={value} type="button" className="min-h-11 border border-line-muted px-3" aria-pressed={focus === value}
            onClick={() => setFocus(value)}>{label}</button>)}
      </div>
      {focus === "wording" ? <>
      <label className="block space-y-1"><span className="font-medium">Item to refine</span>
        <select className="min-h-11 w-full border border-line-muted bg-raised px-3" value={targetIndex}
          onChange={event => setTargetIndex(Number(event.target.value))}>
          {targets.map((option, index) => <option key={`${option.type}:${option.id}`} value={index}>{option.label}</option>)}
        </select></label>
      {target?.sourceText && <div className="border border-line-muted p-3"><p className="text-12 font-medium">Source wording</p>
        <p className="whitespace-pre-wrap text-14">{target.sourceText}</p></div>}
      <fieldset className="space-y-2"><legend className="font-medium">How should this item change?</legend>
        <label className="flex min-h-11 items-center gap-2"><input type="radio" name="refinement-kind" checked={kind === "exact_wording"}
          onChange={() => setKind("exact_wording")} /> Keep my exact wording</label>
        <label className="flex min-h-11 items-center gap-2"><input type="radio" name="refinement-kind" checked={kind === "instruction"}
          onChange={() => setKind("instruction")} /> Give a writing instruction</label>
      </fieldset>
      <label className="block space-y-1"><span className="font-medium">{kind === "exact_wording" ? "Exact wording" : "Instruction for this role"}</span>
        <textarea className="min-h-24 w-full border border-line-muted bg-raised p-3" value={text}
          maxLength={kind === "instruction" ? 2000 : 40000} onChange={event => setText(event.target.value)} /></label>
      <button type="button" className="min-h-11 border border-line-muted px-4" disabled={pending || !text.trim() || sourceChanged} onClick={save}>
        {pending ? "Saving…" : editingId ? "Update refinement · free" : "Save refinement · free"}</button>
      </> : focus === "targeting" ? targetingView && choices ? <>
        <CvTargetingControls view={targetingView} value={choices} context="refine"
          onChange={next => { setChoices(next); setStructureDirty(true); }} />
        <button type="button" className="min-h-11 border border-line-muted px-4" disabled={pending || sourceChanged}
          onClick={saveStructure}>{editingId ? "Update role choices · free" : "Remember role choices · free"}</button>
      </> : <p className="text-14 text-muted">Open a saved edition with a current role assessment to change role priorities and evidence treatment.</p>
      : focus === "appearance" && appearance ? <>
        <CvAppearance value={appearance} onChange={next => { setAppearance(next); setStructureDirty(true); }} />
        <button type="button" className="min-h-11 border border-line-muted px-4" disabled={pending || sourceChanged} onClick={saveStructure}>
          {editingId ? "Update layout choice · free" : "Remember layout choice · free"}</button>
      </> : focus === "order" && sourceTargets ? <>
        <p className="text-12 text-muted">Move sections and skill labels by their saved identities. New output keeps only skills it can support.</p>
        {sectionOrder.map((sectionId, index) => {
          const sourceIndex = sourceTargets.sections.findIndex(row => row.sectionId === sectionId);
          const section = sourceContent?.sections[sourceIndex];
          const ids = itemOrder[sectionId] ?? [];
          return <div key={sectionId} className="border border-line-muted p-2">
            <div className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1">{section?.heading ?? "Saved section"}</span>
              <button type="button" className="min-h-11 border border-line-muted px-3" aria-label={`Move ${section?.heading ?? "section"} up`}
                disabled={index === 0} onClick={() => { const next = [...sectionOrder]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; setSectionOrder(next); setStructureDirty(true); }}>↑</button>
              <button type="button" className="min-h-11 border border-line-muted px-3" aria-label={`Move ${section?.heading ?? "section"} down`}
                disabled={index === sectionOrder.length - 1} onClick={() => { const next = [...sectionOrder]; [next[index], next[index + 1]] = [next[index + 1]!, next[index]!]; setSectionOrder(next); setStructureDirty(true); }}>↓</button>
            </div>
            {section?.skillItems && ids.map((itemId, itemIndex) => {
              const original = sourceTargets.sections[sourceIndex]?.skillIds.indexOf(itemId) ?? -1;
              return <div key={itemId} className="ml-3 flex items-center gap-2"><span className="min-w-0 flex-1">{section.skillItems?.[original]}</span>
                <button type="button" className="min-h-11 border border-line-muted px-3" aria-label={`Move ${section.skillItems?.[original]} up`}
                  disabled={itemIndex === 0} onClick={() => { const next = [...ids]; [next[itemIndex - 1], next[itemIndex]] = [next[itemIndex]!, next[itemIndex - 1]!]; setItemOrder({ ...itemOrder, [sectionId]: next }); setStructureDirty(true); }}>↑</button>
                <button type="button" className="min-h-11 border border-line-muted px-3" aria-label={`Move ${section.skillItems?.[original]} down`}
                  disabled={itemIndex === ids.length - 1} onClick={() => { const next = [...ids]; [next[itemIndex], next[itemIndex + 1]] = [next[itemIndex + 1]!, next[itemIndex]!]; setItemOrder({ ...itemOrder, [sectionId]: next }); setStructureDirty(true); }}>↓</button>
              </div>;
            })}
          </div>;
        })}
        <button type="button" className="min-h-11 border border-line-muted px-4" disabled={pending || sourceChanged} onClick={saveStructure}>
          {editingId ? "Update order · free" : "Remember order · free"}</button>
      </> : null}
    </>}
    {refinements.length > 0 && <div className="space-y-2"><h3 className="font-semibold">Remembered for this role</h3>
      <ul className="space-y-2">{refinements.map(row => <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 border border-line-muted p-2">
        <span>{row.kind === "exact_wording" ? "Exact wording" : row.kind === "instruction" ? "Instruction" : "Structured choice"}: {row.text ?? row.target.type}</span>
        {conflicts.filter(item => item.id === row.id).map(item => <span key={item.reason} role="status" className="text-12 text-warn">
          {item.reason === "changed_role" ? "Role description changed" : item.reason === "changed_source" ? "Source evidence changed"
            : item.reason === "missing_target" ? "This item is no longer in the source"
              : item.reason === "duplicate_target" ? "Two locks target this item" : "This choice cannot fit the current CV"}. Edit from the current source or reset it.
        </span>)}
        <button type="button" className="min-h-11 border border-line-muted px-3" disabled={pending} onClick={() => edit(row)}>Edit this</button>
        <button type="button" className="min-h-11 border border-line-muted px-3" disabled={pending} onClick={() => reset(row.id)}>Reset this</button>
      </li>)}</ul>
      <button type="button" className="min-h-11 border border-line-muted px-3" disabled={pending} onClick={() => reset()}>Reset all</button>
      <button type="button" className="min-h-11 border border-line-muted px-3" disabled={pending || !!text.trim() || structureDirty || !source || sourceChanged || conflicts.length > 0}
        onClick={generate}>{needsNewGeneration ? "Generate CV with saved refinements" : "Apply saved refinements · free"}</button>
      <p className="text-12 text-muted">{needsNewGeneration
        ? "A new generation uses one CV credit; an identical saved result is reused free."
        : "These choices apply to the saved Auto result without generation or a CV credit."} Saved wording is never added to Experience automatically.</p>
    </div>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="text-danger">{error}</p>}
  </div>;
}
