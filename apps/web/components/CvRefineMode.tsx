"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CvRefinementConflict, CvRefinementV1 } from "@col/core/cv-editing-modes";
import type { CvEditingTargets } from "@col/core/cv-editing-modes";
import type { CvContent } from "@col/core/cv";
import type { CvTargetingChoices, CvTargetingView } from "@col/core/cv-targeting";
import type { CvTheme } from "@col/core/cv-theme-values";
import { useCvContextLayout } from "./CvContextLayout";
import { CvTargetingControls, initialCvTargetingChoices, cvTargetingChoiceIssue } from "./CvTargetingPanel";
import { generateRefinedCv, resetCvRefinement, saveAndUpdateCvExactRefinement, saveCvRefinement,
  selectCvEdition } from "@/app/actions/cv-editing";

export type RefinementTargetOption = { type: CvRefinementV1["target"]["type"]; id?: string; label: string;
  sourceText: string; entryId?: string };

export function CvRefineMode({ contextId, source: incomingSource, initialVersion, targets: incomingTargets, refinements,
  appliedRefinements = [],
  sourceContent: incomingContent = null, sourceTargets: incomingSourceTargets = null,
  targetingView: incomingTargetingView = null, sourceTheme: incomingTheme, conflicts = [] }: {
  contextId: string; source: { kind: "baseline" | "draft"; id: string; revision?: number; label: string; autoOrigin?: boolean } | null;
  initialVersion: number; targets: RefinementTargetOption[]; refinements: CvRefinementV1[];
  appliedRefinements?: Array<{ id: string; version: number }>;
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
  const [text, setText] = useState(() => incomingTargets[0]?.sourceText ?? "");
  const [textBase, setTextBase] = useState(() => incomingTargets[0]?.sourceText ?? "");
  const buffers = useRef({ exact: incomingTargets[0]?.sourceText ?? "", instruction: "" });
  const bufferBases = useRef({ exact: incomingTargets[0]?.sourceText ?? "", instruction: "" });
  const exactIntent = useRef<{ signature: string; key: string } | null>(null);
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
  const [awaitingChild, setAwaitingChild] = useState<{ id: string; revision: number } | null>(null);
  const wordingDirty = text !== textBase;
  const anyWordingDirty = wordingDirty || buffers.current.exact !== bufferBases.current.exact ||
    buffers.current.instruction !== bufferBases.current.instruction;
  const target = targets[targetIndex];
  // Skill sections mirror their printable labels in bullets for provenance. Show the item once;
  // retain the mirrored bullet target in the secondary picker for existing remembered rules.
  const visibleTargets = targets.filter(option => option.type !== "bullet" || !sourceTargets?.sections.some((ids, index) =>
    sourceContent?.sections[index]?.kind === "skill" && ids.bulletIds.includes(option.id ?? "")));
  const contextualTargets = target && !visibleTargets.includes(target) ? [...visibleTargets, target] : visibleTargets;
  const unappliedRefinements = refinements.filter(row => !appliedRefinements.some(applied =>
    applied.id === row.id && applied.version === row.version));
  const needsNewGeneration = !(source?.kind === "baseline" || source?.autoOrigin) ||
    refinements.some(row => row.kind === "instruction");
  const sourceChanged = incomingSource?.id !== source?.id || incomingSource?.kind !== source?.kind ||
    incomingSource?.revision !== source?.revision;
  useCvContextLayout("refine", appearance, next => { setAppearance(next); setStructureDirty(true); },
    () => saveStructure("appearance"), pending || !!awaitingChild || sourceChanged);
  function chooseTarget(index: number) {
    if (pending || awaitingChild) return;
    if (index === targetIndex) return;
    if (anyWordingDirty) { setError("Save or clear this wording before choosing another item. Your text remains here."); return; }
    const nextText = kind === "exact_wording" ? targets[index]?.sourceText ?? "" : "";
    buffers.current = { exact: targets[index]?.sourceText ?? "", instruction: "" };
    bufferBases.current = { ...buffers.current };
    setText(nextText); setTextBase(nextText);
    setError(null); setEditingId(null); setTargetIndex(index);
    requestAnimationFrame(() => document.getElementById("cv-refine-wording")?.focus());
  }
  function chooseKind(next: "exact_wording" | "instruction") {
    if (pending || awaitingChild) return;
    if (next === kind) return;
    if (kind === "exact_wording") buffers.current.exact = text; else buffers.current.instruction = text;
    const nextText = next === "exact_wording" ? buffers.current.exact : buffers.current.instruction;
    const held = refinements.find(row => row.id === editingId && row.kind === next);
    setKind(next); setText(nextText);
    setTextBase(held?.text ?? (next === "exact_wording" ? bufferBases.current.exact : bufferBases.current.instruction));
  }
  useEffect(() => {
    const savedChildArrived = !!awaitingChild && incomingSource?.kind === "draft" &&
      incomingSource.id === awaitingChild.id && incomingSource.revision === awaitingChild.revision;
    if (!sourceChanged) return;
    if (savedChildArrived) {
      const selectedIndex = incomingTargets.findIndex(option => option.type === target?.type && option.id === target.id);
      if (selectedIndex < 0) { setError("The saved item changed. Refresh this CV before editing again."); return; }
      const savedText = incomingTargets[selectedIndex]!.sourceText;
      setBase({ source: incomingSource, targets: incomingTargets, sourceContent: incomingContent,
        sourceTargets: incomingSourceTargets, targetingView: incomingTargetingView, sourceTheme: incomingTheme });
      setVersion(initialVersion); setTargetIndex(selectedIndex);
      setText(savedText); setTextBase(savedText); setKind("exact_wording");
      buffers.current.exact = savedText; bufferBases.current.exact = savedText;
      setAwaitingChild(null);
      return;
    }
    if (awaitingChild) {
      setAwaitingChild(null);
      setNotice("A different saved edition was selected. Review the wording here before continuing.");
    }
    if (anyWordingDirty || structureDirty || editingId) return;
    setBase({ source: incomingSource, targets: incomingTargets, sourceContent: incomingContent,
      sourceTargets: incomingSourceTargets, targetingView: incomingTargetingView, sourceTheme: incomingTheme });
    setVersion(initialVersion);
    setTargetIndex(0); setChoices(incomingTargetingView ? initialCvTargetingChoices(incomingTargetingView) : null);
    setAppearance(incomingTheme ?? null);
    setSectionOrder(incomingSourceTargets?.sections.map(row => row.sectionId) ?? []);
    setItemOrder(Object.fromEntries(incomingSourceTargets?.sections.filter((_, index) =>
      incomingContent?.sections[index]?.kind === "skill").map(row => [row.sectionId, row.skillIds]) ?? []));
    const nextText = incomingTargets[0]?.sourceText ?? "";
    setText(nextText); setTextBase(nextText); setKind("exact_wording");
    buffers.current = { exact: nextText, instruction: "" };
    bufferBases.current = { exact: nextText, instruction: "" };
  }, [sourceChanged, incomingSource, incomingTargets, incomingContent, incomingSourceTargets,
    incomingTargetingView, incomingTheme, initialVersion, anyWordingDirty, structureDirty, editingId, awaitingChild,
    target]);

  async function save() {
    if (!source || !target || pending || awaitingChild || sourceChanged || !wordingDirty || !text.trim()) return;
    setPending(true); setError(null); setNotice(null);
    try {
      const order = editingId ? refinements.find(row => row.id === editingId)?.order ?? refinements.length : refinements.length;
      if (kind === "exact_wording") {
        if (!target.id || !["summary", "section", "bullet", "skill"].includes(target.type)) {
          setError("Choose a saved CV item to edit."); return;
        }
        const exactTarget = { type: target.type as "summary" | "section" | "bullet" | "skill", id: target.id };
        const remembered = refinements.find(row => row.kind === "exact_wording" &&
          row.target.type === exactTarget.type && row.target.id === exactTarget.id);
        const rememberedId = editingId ?? remembered?.id;
        const exactOrder = remembered?.order ?? order;
        const signature = JSON.stringify({ contextId, version, source, target: exactTarget, text, rememberedId, exactOrder });
        if (exactIntent.current?.signature !== signature) exactIntent.current = { signature, key: crypto.randomUUID() };
        const result = await saveAndUpdateCvExactRefinement(contextId, version,
          { kind: source.kind, id: source.id, revision: source.revision },
          { ...(rememberedId ? { id: rememberedId } : {}), target: exactTarget, text, order: exactOrder,
            requestKey: exactIntent.current.key });
        if (!result.ok) setError(result.error);
        else { exactIntent.current = null; setVersion(result.version); setTextBase(text); bufferBases.current.exact = text; setEditingId(null);
          setAwaitingChild({ id: result.draftId, revision: result.revision });
          setNotice("CV updated. This wording is remembered for this role."); router.refresh(); }
      } else {
        const result = await saveCvRefinement(contextId, version, { kind,
          ...(editingId ? { id: editingId } : {}),
          target: { type: target.type, ...(target.id ? { id: target.id } : {}) }, text, order,
          sourceKind: source.kind, sourceId: source.id });
        if (!result.ok) setError(result.error);
        else { setVersion(result.version); setTextBase(text); bufferBases.current.instruction = text; setEditingId(null);
          setNotice("Instruction saved for this role. Generate explicitly to update the CV."); router.refresh(); }
      }
    } catch { setError("Could not save this refinement. Your wording is still here."); }
    finally { setPending(false); }
  }
  async function saveStructure(selectedFocus: "wording" | "targeting" | "appearance" | "order" = focus) {
    if (!source || pending || awaitingChild || sourceChanged) return;
    const structured: CvRefinementV1["structured"] = selectedFocus === "targeting" && choices ? { kind: "targeting", choices }
      : selectedFocus === "appearance" && appearance ? { kind: "appearance", theme: appearance }
        : selectedFocus === "order" && sourceTargets ? { kind: "item_order", sectionIds: sectionOrder, itemIds: itemOrder }
          : undefined;
    if (!structured) return;
    const issue = selectedFocus === "targeting" && targetingView && choices ? cvTargetingChoiceIssue(targetingView, choices) : null;
    if (issue) { setError(issue); return; }
    const matchingEdit = refinements.find(row => row.id === editingId && row.structured?.kind === structured.kind);
    setPending(true); setError(null); setNotice(null);
    try {
      const result = await saveCvRefinement(contextId, version, {
        ...(matchingEdit ? { id: matchingEdit.id } : {}), kind: "structured",
        target: { type: selectedFocus === "appearance" ? "appearance" : "selection" }, structured,
        order: matchingEdit?.order ?? refinements.length,
        sourceKind: source.kind, sourceId: source.id,
      });
      if (!result.ok) setError(result.error);
      else { setVersion(result.version); setEditingId(null); setStructureDirty(false);
        setNotice("This choice is remembered for this application."); router.refresh(); }
    } catch { setError("Could not save this choice. It remains here for you to retry."); }
    finally { setPending(false); }
  }
  function edit(row: CvRefinementV1) {
    if (pending || awaitingChild) return;
    if (anyWordingDirty && row.id !== editingId) { setError("Save or clear this wording before editing another remembered item."); return; }
    setEditingId(row.id);
    setStructureDirty(false);
    if (row.kind === "structured") {
      if (row.structured?.kind === "targeting") { setFocus("targeting"); setChoices(row.structured.choices); }
      if (row.structured?.kind === "appearance") { setFocus("appearance"); setAppearance(row.structured.theme); }
      if (row.structured?.kind === "item_order") { setFocus("order"); setSectionOrder(row.structured.sectionIds); setItemOrder(row.structured.itemIds); }
    } else {
      setFocus("wording"); setKind(row.kind);
      setTargetIndex(Math.max(0, targets.findIndex(option => option.type === row.target.type && option.id === row.target.id)));
      setText(row.text ?? ""); setTextBase(row.text ?? "");
      if (row.kind === "exact_wording") buffers.current.exact = row.text ?? "";
      else buffers.current.instruction = row.text ?? "";
      if (row.kind === "exact_wording") bufferBases.current.exact = row.text ?? "";
      else bufferBases.current.instruction = row.text ?? "";
    }
  }
  async function reset(id?: string) {
    if (pending || awaitingChild) return;
    setPending(true); setError(null); setNotice(null);
    try {
      const result = await resetCvRefinement(contextId, version, id);
      if (!result.ok) setError(result.error);
      else { setVersion(result.version);
        setNotice(id ? "Remembered change removed. Your current CV is unchanged."
          : "All refinements reset. The clean Auto result is selected again; prior saved editions remain in history.");
        router.refresh(); }
    } catch { setError("Could not reset the refinement. Please try again."); }
    finally { setPending(false); }
  }
  async function generate() {
    if (!source || !unappliedRefinements.length || pending || awaitingChild || sourceChanged) return;
    if (conflicts.length) { setError("Resolve or reset the marked refinements before generating."); return; }
    if (anyWordingDirty || structureDirty) { setError("Save your current changes before generating. They are still here."); return; }
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

  return <div className="space-y-4 border border-line-muted p-4 text-14" data-cv-mode-dirty={anyWordingDirty || structureDirty ? "true" : "false"}>
    <div><h2 className="font-semibold">Refine this application</h2>
      <p className="text-12 text-muted">Remember only edits you choose for this role. A Manual edition can be a comparison source; none of its wording is promoted automatically.</p></div>
    {!source || !targets.length ? <p>Choose a saved Auto or Manual edition with stable text targets to start refining.</p> : <>
      <p className="text-12 text-muted">Comparing with: {source.label}</p>
      {sourceChanged && <div role="alert" className="space-y-2 border border-warn p-3 text-14">
        <p>The selected edition changed while this refinement buffer was open. Your wording remains here for its original source. Re-select that source from history to save it.</p>
        {(source?.kind !== incomingSource?.kind || source?.id !== incomingSource?.id) && source &&
          <button type="button" className="min-h-11 border border-line-muted px-3" disabled={pending}
            onClick={async () => {
              setPending(true); setError(null);
              try {
                const result = await selectCvEdition(contextId, source.kind, source.id);
                if (!result.ok) setError(result.error);
                else { setNotice("Your original saved edition is selected again. Your wording remains here."); router.refresh(); }
              } catch { setError("Could not restore that saved edition. Your wording remains here."); }
              finally { setPending(false); }
            }}>Restore original saved edition</button>}
        <button type="button" className="min-h-11 border border-line-muted px-3" onClick={async () => {
          try { await navigator.clipboard.writeText(text); setNotice("Unsaved wording copied."); }
          catch { setError("Could not copy automatically. Select the wording above and copy it before changing editions."); }
        }}>Copy unsaved wording</button>
      </div>}
      {awaitingChild && <div className="space-y-2"><p role="status">Updating the selected CV. Editing will resume when the saved edition is shown.</p>
        <button type="button" className="min-h-11 border border-line-muted px-3" onClick={() => router.refresh()}>
          Refresh saved CV</button></div>}
      <div role="group" aria-label="Refinement type" className="flex flex-wrap gap-2">
        {([ ["wording", "Wording or instruction"], ["targeting", "Role priorities and evidence"],
          ["order", "Section and skill order"] ] as const).map(([value, label]) =>
          <button key={value} type="button" className="min-h-11 border border-line-muted px-3" aria-pressed={focus === value}
            onClick={() => setFocus(value)}>{label}</button>)}
      </div>
      {focus === "wording" ? <>
      <div className="space-y-3" aria-label="Saved wording to refine">
        {contextualTargets.filter(option => ["summary", "section", "bullet", "skill"].includes(option.type)).map(option => {
          const index = targets.indexOf(option);
          const remembered = refinements.filter(row => row.target.type === option.type && row.target.id === option.id);
          return <section key={`${option.type}:${option.id}`} className="border-b border-line-muted py-2"
            data-cv-source-entry={option.entryId} data-cv-source-summary={option.type === "summary" ? "true" : undefined}>
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 whitespace-pre-wrap"><strong>{option.type === "section" ? "Heading" : option.label}</strong>
                {!visibleTargets.includes(option) && " · Historical mirrored target"}{option.sourceText ? ` · ${option.sourceText}` : ""}</p>
              <button type="button" className="min-h-11 border border-line-muted px-3" aria-pressed={targetIndex === index}
                disabled={pending || !!awaitingChild}
                onClick={() => chooseTarget(index)}>
                {targetIndex === index ? "Editing" : "Edit wording"}</button>
              {remembered.map(row => <span key={row.id} className="flex flex-wrap items-center gap-2">
                <span className="text-12 text-accent">Remembered {row.kind === "instruction" ? "instruction" : "wording"}</span>
                <button type="button" className="min-h-11 border border-line-muted px-3" disabled={pending || !!awaitingChild} onClick={() => edit(row)}>Edit</button>
                <button type="button" className="min-h-11 border border-line-muted px-3" disabled={pending || !!awaitingChild} onClick={() => reset(row.id)}>Forget for future builds</button>
              </span>)}
            </div>
            {targetIndex === index && <div className="mt-3 space-y-2 border-t border-line-muted pt-3">
              <fieldset className="space-y-2"><legend className="font-medium">How should this item change?</legend>
                <label className="flex min-h-11 items-center gap-2"><input type="radio" name="refinement-kind" checked={kind === "exact_wording"}
                  disabled={pending || !!awaitingChild}
                  onChange={() => chooseKind("exact_wording")} /> Keep my exact wording</label>
                <label className="flex min-h-11 items-center gap-2"><input type="radio" name="refinement-kind" checked={kind === "instruction"}
                  disabled={pending || !!awaitingChild}
                  onChange={() => chooseKind("instruction")} /> Give a writing instruction</label>
              </fieldset>
              <label htmlFor="cv-refine-wording" className="block font-medium">
                {kind === "exact_wording" ? "Exact wording" : "Instruction for this role"}</label>
              <textarea id="cv-refine-wording" className="min-h-24 w-full border border-line-muted bg-raised p-3" value={text}
                disabled={pending || !!awaitingChild || sourceChanged}
                maxLength={kind === "instruction" ? 2000 : 40000} onChange={event => { setText(event.target.value);
                  if (kind === "exact_wording") buffers.current.exact = event.target.value;
                  else buffers.current.instruction = event.target.value; }} />
              <button type="button" className="min-h-11 border border-line-muted px-4" disabled={pending || !!awaitingChild || !wordingDirty || !text.trim() || sourceChanged} onClick={save}>
                {pending ? "Saving…" : kind === "exact_wording" ? "Save and update CV · free" : "Save instruction · free"}</button>
            </div>}
          </section>;
        })}
      </div>
      <details><summary className="cursor-pointer">Find an item by name</summary><label className="mt-2 block space-y-1"><span>Item to refine</span>
        <select className="min-h-11 w-full border border-line-muted bg-raised px-3" value={targetIndex}
          disabled={pending || !!awaitingChild}
          onChange={event => chooseTarget(Number(event.target.value))}>
          {targets.map((option, index) => <option key={`${option.type}:${option.id}`} value={index}>{option.label}</option>)}
        </select></label></details>
      </> : focus === "targeting" ? targetingView && choices ? <>
        <CvTargetingControls view={targetingView} value={choices} context="refine"
          onChange={next => { if (!awaitingChild) { setChoices(next); setStructureDirty(true); } }} />
        <button type="button" className="min-h-11 border border-line-muted px-4" disabled={pending || !!awaitingChild || sourceChanged}
          onClick={() => saveStructure()}>{editingId ? "Update role choices · free" : "Remember role choices · free"}</button>
      </> : <p className="text-14 text-muted">Open a saved edition with a current role assessment to change role priorities and evidence treatment.</p>
      : focus === "order" && sourceTargets ? <>
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
        <button type="button" className="min-h-11 border border-line-muted px-4" disabled={pending || !!awaitingChild || sourceChanged} onClick={() => saveStructure()}>
          {editingId ? "Update order · free" : "Remember order · free"}</button>
      </> : null}
    </>}
    {refinements.length > 0 && <div className="space-y-2"><h3 className="font-semibold">Remembered for this role</h3>
      <ul className="space-y-2">{refinements.filter(row => row.kind === "structured" ||
        conflicts.some(item => item.id === row.id) ||
        !targets.some(option => option.type === row.target.type && option.id === row.target.id))
        .map(row => <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 border border-line-muted p-2">
        <span>{row.kind === "exact_wording" ? "Exact wording" : row.kind === "instruction" ? "Instruction" : "Structured choice"}: {row.text ?? row.target.type}</span>
        {conflicts.filter(item => item.id === row.id).map(item => <span key={item.reason} role="status" className="text-12 text-warn">
          {item.reason === "changed_role" ? "Role description changed" : item.reason === "changed_source" ? "Source evidence changed"
            : item.reason === "missing_target" ? "This item is no longer in the source"
              : item.reason === "duplicate_target" ? "Two locks target this item" : "This choice cannot fit the current CV"}. Edit from the current source or reset it.
        </span>)}
        <button type="button" className="min-h-11 border border-line-muted px-3" disabled={pending || !!awaitingChild} onClick={() => edit(row)}>Edit this</button>
        <button type="button" className="min-h-11 border border-line-muted px-3" disabled={pending || !!awaitingChild} onClick={() => reset(row.id)}>Forget for future builds</button>
      </li>)}</ul>
      <button type="button" className="min-h-11 border border-line-muted px-3" disabled={pending || !!awaitingChild} onClick={() => reset()}>Reset all</button>
      {unappliedRefinements.length > 0 && <><button type="button" className="min-h-11 border border-line-muted px-3" disabled={pending || !!awaitingChild || anyWordingDirty || structureDirty || !source || sourceChanged || conflicts.length > 0}
        onClick={generate}>{needsNewGeneration ? "Generate CV with saved refinements" : "Apply saved refinements · free"}</button>
      <p className="text-12 text-muted">{needsNewGeneration
        ? "A new generation uses one CV credit; an identical saved result is reused free."
        : "These choices apply to the saved Auto result without generation or a CV credit."} Saved wording is never added to Experience automatically.</p></>}
    </div>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="text-danger">{error}</p>}
  </div>;
}
