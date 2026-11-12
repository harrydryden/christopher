"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CvRefinementConflict, CvRefinementV1 } from "@col/core/cv-editing-modes";
import { cvNeedsAuthoredRebuild, cvRemovedAppliedRefinements } from "@col/core/cv-refinement-state";
import type { CvEditingTargets } from "@col/core/cv-editing-modes";
import type { CvContent } from "@col/core/cv";
import type { CvTargetingChoices, CvTargetingView } from "@col/core/cv-targeting";
import type { CvTheme } from "@col/core/cv-theme-values";
import { useCvContextLayout } from "./CvContextLayout";
import { CvTargetingControls, initialCvTargetingChoices, cvTargetingChoiceIssue } from "./CvTargetingPanel";
import { generateRefinedCv, resetCvRefinement, saveAndUpdateCvExactRefinement, saveCvRefinement,
  selectCvEdition } from "@/app/actions/cv-editing";
import { CvInlineWritingTool, type CvInlineQuotes } from "./CvInlineWritingTool";
import { CvModeSkillSuggestions } from "./CvModeSkillSuggestions";

export type RefinementTargetOption = { type: CvRefinementV1["target"]["type"]; id?: string; label: string;
  sourceText: string; sourceSignpost?: string | null; proseBullet?: boolean; entryId?: string };
type DirectDraft = { text: string; title: string };
const targetKey = (option: RefinementTargetOption) => `${option.type}:${option.id ?? ""}`;
const directFrom = (options: RefinementTargetOption[]) => Object.fromEntries(options.map(option =>
  [targetKey(option), { text: option.sourceText, title: option.sourceSignpost ?? "" }])) as Record<string, DirectDraft>;

function inputSelection(id: string) {
  const input = document.getElementById(id) as HTMLTextAreaElement | HTMLInputElement | null;
  return input ? { start: input.selectionStart ?? 0, end: input.selectionEnd ?? 0 } : null;
}

export function CvRefineMode({ contextId, source: incomingSource, initialVersion, targets: incomingTargets, refinements,
  appliedRefinements = [],
  appliedSnapshot = [],
  inlineQuotes, wholeCvQuote,
  skillQuote, skillDraft,
  sourceContent: incomingContent = null, sourceTargets: incomingSourceTargets = null,
  targetingView: incomingTargetingView = null, sourceTheme: incomingTheme, conflicts = [] }: {
  contextId: string; source: { kind: "baseline" | "draft"; id: string; revision?: number; label: string; autoOrigin?: boolean } | null;
  initialVersion: number; targets: RefinementTargetOption[]; refinements: CvRefinementV1[];
  inlineQuotes?: CvInlineQuotes;
  wholeCvQuote?: { charge: "role_credit" | "allowance"; units: number; priceVersion: number };
  skillQuote?: { charge: "role_credit" | "allowance"; units: number; priceVersion: number };
  skillDraft?: { id: string; revision: number; libraryVersion: number } | null;
  appliedRefinements?: Array<{ id: string; version: number }>;
  appliedSnapshot?: CvRefinementV1[];
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
  const [bulletTitle, setBulletTitle] = useState(() => incomingTargets[0]?.sourceSignpost ?? "");
  const [bulletTitleBase, setBulletTitleBase] = useState(() => incomingTargets[0]?.sourceSignpost ?? "");
  const [directDrafts, setDirectDrafts] = useState<Record<string, DirectDraft>>(() => directFrom(incomingTargets));
  const buffers = useRef({ exact: incomingTargets[0]?.sourceText ?? "", instruction: "" });
  const bufferBases = useRef({ exact: incomingTargets[0]?.sourceText ?? "", instruction: "" });
  const exactIntent = useRef<{ signature: string; key: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [focus, setFocus] = useState<"wording" | "instructions" | "targeting" | "appearance" | "order" | "skills">("wording");
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
  const [awaitingChild, setAwaitingChild] = useState<
    { kind: "exact"; id: string; revision: number; targetKey: string } | { kind: "generated"; id: string } | null>(null);
  const titleDirty = targetIndex < targets.length && targets[targetIndex]?.type === "bullet" &&
    targets[targetIndex]?.proseBullet &&
    bulletTitle.trim() !== bulletTitleBase;
  const wordingDirty = text !== textBase || (kind === "exact_wording" && titleDirty);
  const directDirty = targets.some(option => {
    const draft = directDrafts[targetKey(option)];
    return draft && (draft.text !== option.sourceText || draft.title.trim() !== (option.sourceSignpost ?? ""));
  });
  const anyWordingDirty = wordingDirty || buffers.current.exact !== bufferBases.current.exact ||
    buffers.current.instruction !== bufferBases.current.instruction || titleDirty || directDirty;
  const target = targets[targetIndex];
  // Skill sections mirror their printable labels in bullets for provenance. Show the item once;
  // retain the mirrored bullet target in the secondary picker for existing remembered rules.
  const visibleTargets = targets.filter(option => option.type !== "bullet" || !sourceTargets?.sections.some((ids, index) =>
    sourceContent?.sections[index]?.kind === "skill" && ids.bulletIds.includes(option.id ?? "")));
  const contextualTargets = target && !visibleTargets.includes(target) ? [...visibleTargets, target] : visibleTargets;
  const unappliedRefinements = refinements.filter(row => !appliedRefinements.some(applied =>
    applied.id === row.id && applied.version === row.version));
  const hasInstruction = refinements.some(row => row.kind === "instruction");
  const pendingInstruction = refinements.some(row => row.kind === "instruction" &&
    !appliedRefinements.some(applied => applied.id === row.id && applied.version === row.version));
  const removedApplied = cvRemovedAppliedRefinements(appliedSnapshot, appliedRefinements, refinements);
  const hasProjectionChange = unappliedRefinements.length > 0 || removedApplied.length > 0;
  const needsNewGeneration = pendingInstruction || (hasInstruction && cvNeedsAuthoredRebuild(removedApplied));
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
    setBulletTitle(targets[index]?.sourceSignpost ?? ""); setBulletTitleBase(targets[index]?.sourceSignpost ?? "");
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
    const savedChildArrived = awaitingChild?.kind === "exact" && incomingSource?.kind === "draft" &&
      incomingSource.id === awaitingChild.id && incomingSource.revision === awaitingChild.revision;
    const generatedChildArrived = awaitingChild?.kind === "generated" && incomingSource?.kind === "draft" &&
      incomingSource.id === awaitingChild.id;
    if (!sourceChanged) return;
    if (generatedChildArrived) {
      const selectedIndex = incomingTargets.findIndex(option => option.type === target?.type && option.id === target.id);
      const nextIndex = selectedIndex < 0 ? 0 : selectedIndex;
      const nextText = incomingTargets[nextIndex]?.sourceText ?? "";
      const nextTitle = incomingTargets[nextIndex]?.sourceSignpost ?? "";
      setBase({ source: incomingSource, targets: incomingTargets, sourceContent: incomingContent,
        sourceTargets: incomingSourceTargets, targetingView: incomingTargetingView, sourceTheme: incomingTheme });
      setDirectDrafts(directFrom(incomingTargets));
      setVersion(initialVersion); setTargetIndex(nextIndex);
      setChoices(incomingTargetingView ? initialCvTargetingChoices(incomingTargetingView) : null);
      setAppearance(incomingTheme ?? null);
      setSectionOrder(incomingSourceTargets?.sections.map(row => row.sectionId) ?? []);
      setItemOrder(Object.fromEntries(incomingSourceTargets?.sections.filter((_, index) =>
        incomingContent?.sections[index]?.kind === "skill").map(row => [row.sectionId, row.skillIds]) ?? []));
      setText(nextText); setTextBase(nextText); setKind("exact_wording");
      setBulletTitle(nextTitle); setBulletTitleBase(nextTitle);
      buffers.current = { exact: nextText, instruction: "" };
      bufferBases.current = { ...buffers.current };
      setStructureDirty(false); setEditingId(null); setError(null); setAwaitingChild(null);
      return;
    }
    if (savedChildArrived) {
      const selectedIndex = incomingTargets.findIndex(option => option.type === target?.type && option.id === target.id);
      if (selectedIndex < 0) { setError("The saved item changed. Refresh this CV before editing again."); return; }
      const savedText = incomingTargets[selectedIndex]!.sourceText;
      const savedTitle = incomingTargets[selectedIndex]!.sourceSignpost ?? "";
      setDirectDrafts(previous => Object.fromEntries(incomingTargets.map(option => {
        const key = targetKey(option);
        const prior = targets.find(item => targetKey(item) === key);
        const held = previous[key];
        return [key, key === awaitingChild.targetKey || !prior || !held ||
          (held.text === prior.sourceText && held.title.trim() === (prior.sourceSignpost ?? ""))
          ? { text: option.sourceText, title: option.sourceSignpost ?? "" } : held];
      })));
      setBase({ source: incomingSource, targets: incomingTargets, sourceContent: incomingContent,
        sourceTargets: incomingSourceTargets, targetingView: incomingTargetingView, sourceTheme: incomingTheme });
      setVersion(initialVersion); setTargetIndex(selectedIndex);
      setText(savedText); setTextBase(savedText); setKind("exact_wording");
      setBulletTitle(savedTitle); setBulletTitleBase(savedTitle);
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
    setDirectDrafts(directFrom(incomingTargets));
    setVersion(initialVersion);
    setTargetIndex(0); setChoices(incomingTargetingView ? initialCvTargetingChoices(incomingTargetingView) : null);
    setAppearance(incomingTheme ?? null);
    setSectionOrder(incomingSourceTargets?.sections.map(row => row.sectionId) ?? []);
    setItemOrder(Object.fromEntries(incomingSourceTargets?.sections.filter((_, index) =>
      incomingContent?.sections[index]?.kind === "skill").map(row => [row.sectionId, row.skillIds]) ?? []));
    const nextText = incomingTargets[0]?.sourceText ?? "";
    setText(nextText); setTextBase(nextText); setKind("exact_wording");
    setBulletTitle(incomingTargets[0]?.sourceSignpost ?? "");
    setBulletTitleBase(incomingTargets[0]?.sourceSignpost ?? "");
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
        const bulletSignpost = target.type === "bullet" && target.proseBullet && titleDirty
          ? bulletTitle.trim() || null : undefined;
        const signature = JSON.stringify({ contextId, version, source, target: exactTarget, text,
          bulletSignpost, rememberedId, exactOrder });
        if (exactIntent.current?.signature !== signature) exactIntent.current = { signature, key: crypto.randomUUID() };
        const result = await saveAndUpdateCvExactRefinement(contextId, version,
          { kind: source.kind, id: source.id, revision: source.revision },
          { ...(rememberedId ? { id: rememberedId } : {}), target: exactTarget, text, order: exactOrder,
            ...(bulletSignpost !== undefined ? { bulletSignpost } : {}),
            requestKey: exactIntent.current.key });
        if (!result.ok) setError(result.error);
        else { exactIntent.current = null; setVersion(result.version); setTextBase(text); bufferBases.current.exact = text;
          setBulletTitleBase(bulletTitle.trim()); setEditingId(null);
          setAwaitingChild({ kind: "exact", id: result.draftId, revision: result.revision, targetKey: targetKey(target) });
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
  async function useInlineChange(option: RefinementTargetOption, nextField: string,
    field: "text" | "signpost" = "text"): Promise<boolean> {
    if (!source || !option.id || pending || awaitingChild || sourceChanged) return false;
    if (!["summary", "section", "bullet", "skill"].includes(option.type)) return false;
    const exactTarget = { type: option.type as "summary" | "section" | "bullet" | "skill", id: option.id };
    const selected = option.id === target?.id && option.type === target.type;
    const held = directDrafts[targetKey(option)] ?? { text: option.sourceText, title: option.sourceSignpost ?? "" };
    const nextBody = field === "text" ? nextField : held.text;
    const nextTitle = field === "signpost" ? nextField : held.title;
    const remembered = refinements.find(row => row.kind === "exact_wording" &&
      row.target.type === exactTarget.type && row.target.id === exactTarget.id);
    const order = remembered?.order ?? refinements.length;
    const bulletSignpost = exactTarget.type === "bullet" && option.proseBullet &&
      (field === "signpost" || nextTitle.trim() !== (option.sourceSignpost ?? "")) ? nextTitle.trim() || null : undefined;
    const signature = JSON.stringify({ contextId, version, source, target: exactTarget,
      text: nextBody, bulletSignpost, rememberedId: remembered?.id, order });
    if (exactIntent.current?.signature !== signature) exactIntent.current = { signature, key: crypto.randomUUID() };
    setPending(true); setError(null); setNotice(null);
    try {
      const result = await saveAndUpdateCvExactRefinement(contextId, version,
        { kind: source.kind, id: source.id, revision: source.revision },
        { ...(remembered ? { id: remembered.id } : {}), target: exactTarget, text: nextBody,
          order, ...(bulletSignpost !== undefined ? { bulletSignpost } : {}), requestKey: exactIntent.current.key });
      if (!result.ok) { setError(result.error); return false; }
      exactIntent.current = null; setVersion(result.version);
      setDirectDrafts(previous => ({ ...previous, [targetKey(option)]: { text: nextBody, title: nextTitle } }));
      if (selected) {
        buffers.current.exact = nextBody; bufferBases.current.exact = nextBody;
        if (kind === "exact_wording") { setText(nextBody); setTextBase(nextBody); }
        setBulletTitle(nextTitle); setBulletTitleBase(nextTitle);
      }
      setAwaitingChild({ kind: "exact", id: result.draftId, revision: result.revision, targetKey: targetKey(option) });
      setNotice("CV updated. This wording is remembered for this role."); router.refresh();
      return true;
    } catch { setError("Could not save this change. Your wording and suggestion remain here."); return false; }
    finally { setPending(false); }
  }
  async function saveDirect(option: RefinementTargetOption) {
    if (!source || !option.id || pending || awaitingChild || sourceChanged) return;
    if (!["summary", "section", "bullet", "skill"].includes(option.type)) return;
    const key = targetKey(option);
    const draft = directDrafts[key] ?? { text: option.sourceText, title: option.sourceSignpost ?? "" };
    if (!draft.text.trim()) { setError("This wording needs some text before it can be saved."); return; }
    if (draft.text === option.sourceText && draft.title.trim() === (option.sourceSignpost ?? "")) return;
    const exactTarget = { type: option.type as "summary" | "section" | "bullet" | "skill", id: option.id };
    const remembered = refinements.find(row => row.kind === "exact_wording" &&
      row.target.type === exactTarget.type && row.target.id === exactTarget.id);
    const titleChanged = option.type === "bullet" && option.proseBullet &&
      draft.title.trim() !== (option.sourceSignpost ?? "");
    const bulletSignpost = titleChanged ? draft.title.trim() || null : undefined;
    const signature = JSON.stringify({ contextId, version, source, target: exactTarget,
      text: draft.text, bulletSignpost, rememberedId: remembered?.id });
    if (exactIntent.current?.signature !== signature) exactIntent.current = { signature, key: crypto.randomUUID() };
    setPending(true); setError(null); setNotice(null);
    try {
      const result = await saveAndUpdateCvExactRefinement(contextId, version,
        { kind: source.kind, id: source.id, revision: source.revision },
        { ...(remembered ? { id: remembered.id } : {}), target: exactTarget,
          text: draft.text, order: remembered?.order ?? refinements.length,
          ...(bulletSignpost !== undefined ? { bulletSignpost } : {}), requestKey: exactIntent.current.key });
      if (!result.ok) { setError(result.error); return; }
      exactIntent.current = null; setVersion(result.version);
      if (targetKey(targets[targetIndex] ?? option) === key) {
        setText(draft.text); setTextBase(draft.text); buffers.current.exact = draft.text; bufferBases.current.exact = draft.text;
        setBulletTitle(draft.title); setBulletTitleBase(draft.title.trim());
      }
      setAwaitingChild({ kind: "exact", id: result.draftId, revision: result.revision, targetKey: key });
      setNotice("CV updated. This wording is remembered for this role."); router.refresh();
    } catch { setError("Could not save this wording. Your text remains here for retry."); }
    finally { setPending(false); }
  }
  async function saveStructure(selectedFocus: "wording" | "instructions" | "targeting" | "appearance" | "order" | "skills" = focus) {
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
      setFocus(row.kind === "instruction" ? "instructions" : "wording"); setKind(row.kind);
      setTargetIndex(Math.max(0, targets.findIndex(option => option.type === row.target.type && option.id === row.target.id)));
      if (row.kind === "exact_wording") {
        const option = targets.find(item => item.type === row.target.type && item.id === row.target.id);
        if (option) setDirectDrafts(previous => ({ ...previous, [targetKey(option)]: {
          text: row.text ?? option.sourceText,
          title: row.bulletSignpost !== undefined ? row.bulletSignpost ?? "" : option.sourceSignpost ?? "",
        } }));
      }
      setText(row.text ?? ""); setTextBase(row.text ?? "");
      const currentTitle = targets.find(option => option.type === row.target.type && option.id === row.target.id)?.sourceSignpost ?? "";
      setBulletTitle(row.bulletSignpost !== undefined ? row.bulletSignpost ?? "" : currentTitle);
      setBulletTitleBase(row.bulletSignpost !== undefined ? row.bulletSignpost ?? "" : currentTitle);
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
    if (!source || !hasProjectionChange || pending || awaitingChild || sourceChanged) return;
    if (conflicts.length) { setError("Resolve or reset the marked refinements before generating."); return; }
    if (anyWordingDirty || structureDirty) { setError("Save your current changes before generating. They are still here."); return; }
    if (document.querySelector('[data-cv-mode-dirty="true"]') &&
      !window.confirm("Apply saved refinements while another mode has unsaved wording? Your text remains on this page, but the selected edition may change.")) return;
    setPending(true); setError(null); setNotice(null);
    try {
      const result = await generateRefinedCv(contextId, version, source.kind, source.id, wholeCvQuote);
      if (!result.ok) setError(result.error);
      else {
        if (result.status === "ready" && result.draftId && !(source.kind === "draft" && source.id === result.draftId))
          setAwaitingChild({ kind: "generated", id: result.draftId });
        setNotice(result.status === "ready" ? "Refined CV ready. No new CV credit was used."
          : result.status === "queued" ? "Refined CV queued. Your current selection stays available while it builds."
            : "This refinement could not be completed. Your saved instructions remain available.");
        router.refresh();
      }
    } catch { setError("Could not start this refinement. Your saved instructions remain available."); }
    finally { setPending(false); }
  }

  return <div className="space-y-4 border border-line-muted p-4 text-14" data-cv-mode-dirty={anyWordingDirty || structureDirty ? "true" : "false"}
    data-cv-mode-pending={pending || awaitingChild ? "true" : "false"}>
    <h2 className="font-semibold">Refine current CV</h2>
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
          try { await navigator.clipboard.writeText(target?.type === "bullet" && bulletTitle.trim()
            ? `${bulletTitle.trim()}\n${text}` : text); setNotice("Unsaved wording copied."); }
          catch { setError("Could not copy automatically. Select the wording above and copy it before changing editions."); }
        }}>Copy unsaved wording</button>
      </div>}
      {awaitingChild && <div className="space-y-2"><p role="status">Updating the selected CV. Editing will resume when the saved edition is shown.</p>
        <button type="button" className="min-h-11 border border-line-muted px-3" onClick={() => router.refresh()}>
          Refresh saved CV</button></div>}
      <nav aria-label="Refine tasks" className="flex flex-wrap gap-2">
        <button type="button" className="min-h-11 border border-line-muted px-3" disabled={pending || !!awaitingChild}
          aria-current={focus === "wording" ? "page" : undefined}
          onClick={() => { chooseKind("exact_wording"); setFocus("wording"); }}>Edit document</button>
        <button type="button" className="min-h-11 border border-line-muted px-3" disabled={pending || !!awaitingChild}
          aria-current={focus === "instructions" ? "page" : undefined}
          onClick={() => { chooseKind("instruction"); setFocus("instructions"); }}>Remembered choices</button>
        <button type="button" className="min-h-11 border border-line-muted px-3" disabled={pending || !!awaitingChild}
          aria-current={focus === "targeting" ? "page" : undefined}
          onClick={() => setFocus("targeting")}>Role priorities</button>
        <button type="button" className="min-h-11 border border-line-muted px-3" disabled={pending || !!awaitingChild}
          aria-current={focus === "order" ? "page" : undefined}
          onClick={() => setFocus("order")}>Order</button>
        <button type="button" className="min-h-11 border border-line-muted px-3" disabled={pending || !!awaitingChild}
          aria-current={focus === "skills" ? "page" : undefined}
          onClick={() => setFocus("skills")}>Skills</button>
      </nav>
      {(focus === "wording" || focus === "instructions") ? <>
      <div className="space-y-3" aria-label="Saved wording to refine">
        {contextualTargets.filter(option => ["summary", "section", "bullet", "skill"].includes(option.type)).map(option => {
          const index = targets.indexOf(option);
          const remembered = refinements.filter(row => row.target.type === option.type && row.target.id === option.id);
          const key = targetKey(option);
          const draft = directDrafts[key] ?? { text: option.sourceText, title: option.sourceSignpost ?? "" };
          const dirtyField = draft.text !== option.sourceText || draft.title.trim() !== (option.sourceSignpost ?? "");
          const fieldId = `cv-refine-direct-${option.id}`;
          const titleId = `cv-refine-title-${option.id}`;
          return <section key={`${option.type}:${option.id}`} className="border-b border-line-muted py-2"
            data-cv-source-entry={option.entryId} data-cv-source-summary={option.type === "summary" ? "true" : undefined}>
            <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <p className="min-w-0 w-full flex-1 whitespace-pre-wrap break-words sm:w-auto"><strong>{option.type === "section" ? "Heading" : option.label}</strong>
                {!visibleTargets.includes(option) && " · Historical mirrored target"}
                {focus === "instructions" && option.sourceText ? ` · ${option.sourceText}` : ""}</p>
              {focus === "instructions" && <button type="button" className="min-h-11 self-start border border-line-muted px-3 sm:self-auto" aria-pressed={targetIndex === index}
                disabled={pending || !!awaitingChild}
                onClick={() => chooseTarget(index)}>
                {targetIndex === index ? "Editing" : "Choose for instruction"}</button>}
              {focus === "wording" && inlineQuotes && source && option.id && <CvInlineWritingTool contextId={contextId}
                source={{ kind: source.kind, id: source.id, revision: source.revision }}
                target={{ type: option.type as "summary" | "section" | "bullet" | "skill", id: option.id, field: "text" }}
                label={option.label} text={draft.text} getSelection={() => inputSelection(fieldId)}
                quotes={inlineQuotes} disabled={pending || !!awaitingChild || sourceChanged}
                onUseChange={next => useInlineChange(option, next)} />}
              {remembered.length > 0 && focus === "wording" && <span className="text-12 text-accent">Remembered for this role</span>}
              {focus === "instructions" && remembered.map(row => <span key={row.id} className="flex flex-wrap items-center gap-2">
                <span className="text-12 text-accent">Remembered {row.kind === "instruction" ? "instruction" : "wording"}</span>
                <button type="button" className="min-h-11 border border-line-muted px-3" disabled={pending || !!awaitingChild} onClick={() => edit(row)}>Edit</button>
                <button type="button" className="min-h-11 border border-line-muted px-3" disabled={pending || !!awaitingChild} onClick={() => reset(row.id)}>Forget for future builds</button>
              </span>)}
            </div>
            {focus === "wording" && <div className="mt-2 space-y-2">
              {option.type === "bullet" && option.proseBullet &&
                <div className="space-y-1"><label htmlFor={titleId} className="block font-medium">Bullet title (optional)</label>
                  <div className="flex flex-wrap items-start gap-2"><input id={titleId} className="min-h-11 min-w-0 flex-1 border border-line-muted bg-raised px-3"
                    aria-label={`Bullet title for ${option.label}`} type="text" maxLength={60} value={draft.title} disabled={pending || !!awaitingChild || sourceChanged}
                    onChange={event => setDirectDrafts(previous => ({ ...previous, [key]: { ...draft, title: event.target.value } }))} />
                  {inlineQuotes && source && option.id && <CvInlineWritingTool contextId={contextId}
                    source={{ kind: source.kind, id: source.id, revision: source.revision }}
                    target={{ type: "bullet", id: option.id, field: "signpost" }} label={`Bullet title for ${option.label}`}
                    text={draft.title} quotes={inlineQuotes} getSelection={() => inputSelection(titleId)}
                    disabled={pending || !!awaitingChild || sourceChanged}
                    onUseChange={next => useInlineChange(option, next, "signpost")} />}</div></div>}
              <label htmlFor={fieldId} className="block font-medium">{option.type === "section" ? "Heading" : option.label}</label>
              <textarea id={fieldId} className="min-h-24 w-full border border-line-muted bg-raised p-3" value={draft.text}
                disabled={pending || !!awaitingChild || sourceChanged}
                maxLength={40000} onChange={event => setDirectDrafts(previous => ({ ...previous, [key]: { ...draft, text: event.target.value } }))} />
              {dirtyField && <button type="button" className="min-h-11 border border-line-muted px-4" disabled={pending || !!awaitingChild || !draft.text.trim() || sourceChanged}
                onClick={() => void saveDirect(option)}>{pending ? "Saving…" : `Save ${option.label} and update CV · free`}</button>}
            </div>}
            {focus === "instructions" && targetIndex === index && <div className="mt-3 space-y-2 border-t border-line-muted pt-3">
              <label htmlFor="cv-refine-wording" className="block font-medium">Instruction for this role</label>
              <textarea id="cv-refine-wording" className="min-h-24 w-full border border-line-muted bg-raised p-3" value={text}
                disabled={pending || !!awaitingChild || sourceChanged} maxLength={2000}
                onChange={event => { setText(event.target.value); buffers.current.instruction = event.target.value; }} />
              <button type="button" className="min-h-11 border border-line-muted px-4" disabled={pending || !!awaitingChild || !wordingDirty || !text.trim() || sourceChanged}
                onClick={save}>{pending ? "Saving…" : "Save instruction · free"}</button>
            </div>}
          </section>;
        })}
      </div>
      {focus === "instructions" && <label className="mt-2 block space-y-1"><span>Choose saved target</span>
        <select className="min-h-11 w-full border border-line-muted bg-raised px-3" value={targetIndex}
          disabled={pending || !!awaitingChild}
          onChange={event => chooseTarget(Number(event.target.value))}>
          {targets.map((option, index) => <option key={`${option.type}:${option.id}`} value={index}>{option.label}</option>)}
        </select></label>}
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
                disabled={pending || !!awaitingChild || index === 0} onClick={() => { const next = [...sectionOrder]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; setSectionOrder(next); setStructureDirty(true); }}>↑</button>
              <button type="button" className="min-h-11 border border-line-muted px-3" aria-label={`Move ${section?.heading ?? "section"} down`}
                disabled={pending || !!awaitingChild || index === sectionOrder.length - 1} onClick={() => { const next = [...sectionOrder]; [next[index], next[index + 1]] = [next[index + 1]!, next[index]!]; setSectionOrder(next); setStructureDirty(true); }}>↓</button>
            </div>
            {section?.skillItems && ids.map((itemId, itemIndex) => {
              const original = sourceTargets.sections[sourceIndex]?.skillIds.indexOf(itemId) ?? -1;
              return <div key={itemId} className="ml-3 flex items-center gap-2"><span className="min-w-0 flex-1">{section.skillItems?.[original]}</span>
                <button type="button" className="min-h-11 border border-line-muted px-3" aria-label={`Move ${section.skillItems?.[original]} up`}
                  disabled={pending || !!awaitingChild || itemIndex === 0} onClick={() => { const next = [...ids]; [next[itemIndex - 1], next[itemIndex]] = [next[itemIndex]!, next[itemIndex - 1]!]; setItemOrder({ ...itemOrder, [sectionId]: next }); setStructureDirty(true); }}>↑</button>
                <button type="button" className="min-h-11 border border-line-muted px-3" aria-label={`Move ${section.skillItems?.[original]} down`}
                  disabled={pending || !!awaitingChild || itemIndex === ids.length - 1} onClick={() => { const next = [...ids]; [next[itemIndex], next[itemIndex + 1]] = [next[itemIndex + 1]!, next[itemIndex]!]; setItemOrder({ ...itemOrder, [sectionId]: next }); setStructureDirty(true); }}>↓</button>
              </div>;
            })}
          </div>;
        })}
        <button type="button" className="min-h-11 border border-line-muted px-4" disabled={pending || !!awaitingChild || sourceChanged} onClick={() => saveStructure()}>
          {editingId ? "Update order · free" : "Remember order · free"}</button>
      </> : focus === "skills" ? <CvModeSkillSuggestions contextId={contextId}
        draftId={skillDraft?.id ?? null} revision={skillDraft?.revision ?? null}
        overlayVersion={version} content={sourceContent} libraryVersion={skillDraft?.libraryVersion ?? null}
        quote={skillQuote ?? null} /> : null}
    </>}
    {focus === "instructions" && refinements.length > 0 && <div className="space-y-2"><h3 className="font-semibold">Remembered for this role</h3>
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
    </div>}
    {hasProjectionChange && <div className="space-y-1"><button type="button" className="min-h-11 border border-line-muted px-3" disabled={pending || !!awaitingChild || anyWordingDirty || structureDirty || !source || sourceChanged || conflicts.length > 0}
        onClick={generate}>{needsNewGeneration ? "Update CV from remembered choices" : "Apply saved refinements · free"}</button>
      {needsNewGeneration && wholeCvQuote && <p className="text-12 text-muted">New AI work: {wholeCvQuote.charge === "role_credit"
        ? "1 role credit for the first successful result" : `${wholeCvQuote.units} AI units`}.</p>}
    </div>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="text-danger">{error}</p>}
  </div>;
}
