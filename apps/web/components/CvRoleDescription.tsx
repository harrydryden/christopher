"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import type { CvRefinementV1 } from "@col/core/cv-editing-modes";
import { applyCvRefinementRebase, previewCvRefinementRebase,
  updateCvApplicationDescription, type CvRebasePreviewResult } from "@/app/actions/cv-editing";

type Baseline = { id: string; status: "queued" | "ready" | "failed";
  descriptionVersionId: string | null; publishedAt?: string | null; roleVersion?: number | null };
type Preview = Extract<CvRebasePreviewResult, { ok: true }>;

/** Updating an advert never rewrites a selected edition or silently rebinds a remembered rule. */
export function CvRoleDescription({ contextId, descriptionVersionId, description, version,
  baselines, initialFrom, originBaselineIds = initialFrom ? [initialFrom] : [], refinementVersion, refinements }: {
  contextId: string; descriptionVersionId: string | null; description: string; version: number;
  baselines: Baseline[]; initialFrom: string | null; originBaselineIds?: string[]; refinementVersion: number;
  refinements: CvRefinementV1[];
}) {
  const router = useRouter();
  const descriptionInputId = useId();
  const fromSelectId = useId();
  const toSelectId = useId();
  const [baseId, setBaseId] = useState(descriptionVersionId);
  const [baseText, setBaseText] = useState(description);
  const [awaitingId, setAwaitingId] = useState<string | null>(null);
  const [text, setText] = useState(description);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [from, setFrom] = useState(originBaselineIds.length === 1 ? originBaselineIds[0]! : "");
  const [to, setTo] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [awaitingRefinementsVersion, setAwaitingRefinementsVersion] = useState<number | null>(null);
  const synchronising = awaitingRefinementsVersion !== null && refinementVersion < awaitingRefinementsVersion;
  useEffect(() => {
    if (awaitingRefinementsVersion !== null && refinementVersion >= awaitingRefinementsVersion)
      setAwaitingRefinementsVersion(null);
  }, [awaitingRefinementsVersion, refinementVersion]);
  const dirty = text !== baseText;
  const stale = baseId !== descriptionVersionId && awaitingId !== descriptionVersionId;
  useEffect(() => {
    if (awaitingId && descriptionVersionId !== awaitingId) return;
    if (!dirty || awaitingId === descriptionVersionId) {
      setBaseId(descriptionVersionId); setBaseText(description); setText(description);
      setAwaitingId(null);
    }
  }, [descriptionVersionId, description, dirty, awaitingId]);
  const eligibleTo = baselines.filter(row => row.status === "ready" && row.descriptionVersionId === descriptionVersionId);
  const selectedTo = eligibleTo.some(row => row.id === to) ? to
    : eligibleTo.length === 1 && eligibleTo[0]!.id !== from ? eligibleTo[0]!.id : "";
  const currentPreview = preview && preview.version === refinementVersion && !stale ? preview : null;
  async function saveDescription() {
    if (pending || !baseId || !dirty || stale) return;
    setPending(true); setError(null); setNotice(null);
    try {
      const result = await updateCvApplicationDescription(contextId, baseId, text);
      if (!result.ok) setError(result.error);
      else { setAwaitingId(result.descriptionVersionId); setNotice("Role description saved. Existing CVs and remembered choices remain unchanged. Update Auto when ready.");
        setPreview(null); router.refresh(); }
    } catch { setError("Could not save the role description. Your text remains here."); }
    finally { setPending(false); }
  }
  async function inspect() {
    if (pending || synchronising) return;
    if (!from || !selectedTo || from === selectedTo) {
      setError("Choose the saved Auto source and current result before reviewing changes."); return;
    }
    setPending(true); setError(null); setNotice(null); setPreview(null);
    try {
      const result = await previewCvRefinementRebase(contextId, refinementVersion, from, selectedTo);
      if (!result.ok) setError(result.error);
      else setPreview(result);
    } catch { setError("Could not preview remembered changes. Try again."); }
    finally { setPending(false); }
  }
  async function apply() {
    const compatibleIds = currentPreview?.items.filter(item => item.status === "compatible").map(item => item.id) ?? [];
    if (pending || synchronising || !currentPreview || !compatibleIds.length) return;
    setPending(true); setError(null); setNotice(null);
    try {
      const result = await applyCvRefinementRebase(contextId, currentPreview.version, from, selectedTo,
        currentPreview.previewKey, compatibleIds);
      if (!result.ok) { setError(result.error); setPreview(null); }
      else { setAwaitingRefinementsVersion(result.version);
        setNotice(`${result.rebasedIds.length} remembered ${result.rebasedIds.length === 1 ? "change" : "changes"} carried to the newer Auto source. Saved CVs remain unchanged until you apply the refinements.`);
        setPreview(null); router.refresh(); }
    } catch { setError("Could not carry the selected changes. Preview them again."); setPreview(null); }
    finally { setPending(false); }
  }
  return <section aria-labelledby="cv-role-description-heading" className="border border-line-muted p-3 text-14">
    <h2 id="cv-role-description-heading" className="font-medium">Role details · version {version}</h2>
    <div className="mt-3 space-y-3">
      <label htmlFor={descriptionInputId} className="block font-medium">Role description for this application</label>
      <textarea id={descriptionInputId} className="min-h-32 w-full border border-line-muted bg-raised p-3" value={text}
        onChange={event => setText(event.target.value)} data-cv-mode-dirty={dirty ? "true" : "false"} />
      {stale && <p role="alert" className="text-warn">A newer role description is saved. Your typed text remains here; copy it before reloading.</p>}
      <button type="button" className="min-h-11 border border-line-muted px-4" disabled={!dirty || stale || pending || !!awaitingId || !text.trim()}
        onClick={saveDescription}>{pending ? "Saving…" : "Update saved role description · free"}</button>
      {refinements.length > 0 && baselines.filter(row => row.status === "ready").length > 1 && <fieldset className="space-y-3 border-t border-line-muted pt-3">
        <legend className="font-medium">Carry remembered changes to a newer Auto result</legend>
        <button type="button" className="min-h-11 border border-line-muted px-4" disabled={pending || synchronising || !eligibleTo.length}
          onClick={inspect}>Review source changes</button>
        {!eligibleTo.length && <p className="text-12 text-muted">Update Auto for the current role description before reviewing remembered changes.</p>}
        <div className="mt-2 space-y-2">
        <label htmlFor={fromSelectId} className="block">From saved Auto result</label>
        <select id={fromSelectId} className="min-h-11 w-full border border-line-muted bg-raised px-3"
          disabled={pending || synchronising}
          value={from} onChange={event => { setFrom(event.target.value); setPreview(null); }}>
          <option value="">Choose source</option>{baselines.filter(row => row.status === "ready").map(row =>
            <option key={row.id} value={row.id}>{row.id === initialFrom ? "Current remembered source" : "Saved Auto result"}
              {row.publishedAt ? ` · ${new Date(row.publishedAt).toLocaleDateString("en-GB")}` : ""}
              {row.roleVersion ? ` · role version ${row.roleVersion}` : ""}</option>)}</select>
        <label htmlFor={toSelectId} className="block">To current role’s Auto result</label>
        <select id={toSelectId} className="min-h-11 w-full border border-line-muted bg-raised px-3"
          disabled={pending || synchronising}
          value={selectedTo} onChange={event => { setTo(event.target.value); setPreview(null); }}>
          <option value="">Choose destination</option>{eligibleTo.map(row => <option key={row.id} value={row.id}>Saved Auto result
            {row.publishedAt ? ` · ${new Date(row.publishedAt).toLocaleDateString("en-GB")}` : ""}
            {row.roleVersion ? ` · role version ${row.roleVersion}` : ""}</option>)}</select>
        </div>
        {currentPreview && <div className="space-y-2">
          <p className="font-medium">{currentPreview.items.filter(item => item.status === "compatible").length} compatible remembered changes</p>
          {currentPreview.items.some(item => item.status === "current") &&
            <p>{currentPreview.items.filter(item => item.status === "current").length} already current on this source.</p>}
          {currentPreview.items.filter(item => item.status === "conflict").map(item => { const rule = refinements.find(row => row.id === item.id);
            const label = rule?.text?.slice(0, 150) || (rule?.structured?.kind === "appearance" ? "Layout choice"
              : rule?.structured?.kind === "targeting" ? "Role priorities and evidence choice"
                : rule?.structured?.kind === "item_order" ? "Section and skill order" : "Remembered wording");
            return <div key={item.id} className="border border-line-muted p-2">
            <p>Needs a new decision: {item.reason.replaceAll("_", " ")} · {label}</p>
            <a className="inline-flex min-h-11 items-center underline" href="#cv-mode-refine">Edit or reset this in Refine</a>
          </div>; })}
          {currentPreview.items.some(item => item.status === "compatible") &&
            <button type="button" className="min-h-11 border border-line-muted px-4" disabled={pending}
              onClick={apply}>Carry compatible changes · free</button>}
        </div>}
      </fieldset>}
      {notice && <p role="status">{notice}</p>}{error && <p role="alert" className="text-danger">{error}</p>}
    </div>
  </section>;
}
