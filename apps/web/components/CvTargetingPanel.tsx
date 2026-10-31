"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CvTargetingChoices, CvTargetingView } from "@col/core/cv-targeting";
import { confirmCvTargetingPriorities, reviseFailedCvTargeting } from "@/app/actions/cv-targeting";
import { selectClass, Textarea } from "@/components/Field";
import { affectedCvTargetingEssentials, cvTargetingChoiceIssue, initialCvTargetingChoices,
  moveCvTargetingRequirement, normaliseCvTargetingChoices, withCvTargetingRequirements } from "@/lib/cv-targeting-choices";
export { cvTargetingChoiceIssue, initialCvTargetingChoices, normaliseCvTargetingChoices } from "@/lib/cv-targeting-choices";

/** Browser-safe controls. Labels and rubric come from an account-scoped server view. */
export function CvTargetingControls({ view, value, onChange, disabled = false }: {
  view: CvTargetingView; value: CvTargetingChoices; onChange: (next: CvTargetingChoices) => void; disabled?: boolean;
}) {
  const essentials = affectedCvTargetingEssentials(view, value);
  const requirements = value.requirements ?? initialCvTargetingChoices(view).requirements ?? [];
  const requirementTable = useRef<HTMLTableElement>(null);
  const lastVisibleWidth = useRef(0);
  const newRequirementToFocus = useRef<string | null>(null);
  const fitRequirementTextareas = useCallback(() => {
    if (!requirementTable.current?.getBoundingClientRect().width) return;
    const fields = [...(requirementTable.current?.querySelectorAll<HTMLTextAreaElement>("textarea[data-requirement-id]") ?? [])];
    fields.forEach(field => { field.style.height = "auto"; });
    const heights = fields.map(field => Math.max(44, field.scrollHeight + field.offsetHeight - field.clientHeight));
    fields.forEach((field, index) => { field.style.height = `${heights[index]}px`; });
  }, []);
  useLayoutEffect(fitRequirementTextareas, [fitRequirementTextareas, requirements]);
  useEffect(() => {
    window.addEventListener("resize", fitRequirementTextareas);
    return () => window.removeEventListener("resize", fitRequirementTextareas);
  }, [fitRequirementTextareas]);
  useEffect(() => {
    const table = requirementTable.current;
    if (!table || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width === lastVisibleWidth.current) return;
      lastVisibleWidth.current = width;
      if (width > 0) fitRequirementTextareas();
    });
    observer.observe(table);
    return () => observer.disconnect();
  }, [fitRequirementTextareas]);
  useEffect(() => {
    const id = newRequirementToFocus.current;
    if (!id) return;
    const field = requirementTable.current?.querySelector<HTMLTextAreaElement>(`textarea[data-requirement-id="${id}"]`);
    if (field) { field.focus(); newRequirementToFocus.current = null; }
  }, [requirements]);
  const sourcePriorities = new Map(view.priorities.map(item => [item.id, item]));
  const changeRequirements = (next: typeof requirements) => onChange(normaliseCvTargetingChoices(view,
    withCvTargetingRequirements(value, next)));
  return <section className="space-y-4 border-2 border-line bg-raised p-4" aria-labelledby="cv-targeting-title">
    <div><h2 id="cv-targeting-title" className="text-18 font-semibold">Target this CV</h2>
      <p className="mt-1 text-14 text-muted">Choose what to feature or omit for this application. Experience and Interests can also be summarised; choose individual skills in Write. Experience stays intact. Save stores your current wording and these choices together; Check and Rewrite remain separate.</p></div>
    <fieldset className="space-y-2" disabled={disabled}><legend className="font-medium">Evidence from Experience</legend>
      <p className="text-12 text-muted">Summarise keeps one sourced bullet; Omit leaves the entry out of this CV.</p>
      <table className="w-full table-fixed border border-line-muted text-left text-14">
        <colgroup><col /><col className="w-40" /></colgroup>
        <thead className="bg-sunken text-13 text-muted"><tr><th scope="col" className="px-3 py-2 font-medium">Evidence</th><th scope="col" className="px-3 py-2 font-medium">Treatment</th></tr></thead>
        <tbody>{view.entries.map(entry => <tr key={entry.entryId} className="border-t border-line-muted">
          <th scope="row" className="break-words px-3 py-2 align-middle font-normal">{entry.heading}{entry.company ? ` · ${entry.company}` : ""}</th>
          <td className="px-3 py-2 align-middle"><select aria-label={`${entry.heading} treatment`} className={`${selectClass} min-h-11 max-w-full`}
            value={value.entries.find(item => item.entryId === entry.entryId)?.treatment ?? "feature"}
            onChange={event => onChange(normaliseCvTargetingChoices(view, { ...value, entries: value.entries.map(item => item.entryId === entry.entryId
              ? { ...item, treatment: event.target.value as CvTargetingChoices["entries"][number]["treatment"] } : item) }))}>
            <option value="feature">Feature</option>{(entry.kind === "experience" || entry.kind === "interest") && <option value="summarise">Summarise</option>}<option value="omit">Omit</option>
          </select></td>
        </tr>)}</tbody>
      </table>
    </fieldset>
    <fieldset className="space-y-2" disabled={disabled}><legend className="font-medium">Role priorities</legend>
      <p className="text-12 text-muted">1 is highest. Rank guides emphasis; Essential requests must-have coverage where evidence supports it. Missing evidence is reported, never invented. Your edits apply to this CV.</p>
      <table ref={requirementTable} className="w-full table-fixed border border-line-muted text-left text-14">
        <thead className="bg-sunken text-13 text-muted"><tr>
          <th scope="col" className="w-16 px-2 py-2 font-medium">Rank</th>
          <th scope="col" className="px-2 py-2 font-medium">Requirement</th>
          <th scope="col" className="hidden w-32 px-2 py-2 font-medium md:table-cell">Essential</th>
          <th scope="col" className="hidden w-28 px-2 py-2 font-medium md:table-cell">Action</th>
        </tr></thead>
        <tbody>{requirements.map((row, index) => {
          const source = sourcePriorities.get(row.id);
          const origin = source?.origin ?? (row.id.startsWith("u:") ? "user" : "role");
          const customised = source?.customised || (source && (row.text !== source.text || row.essential !== source.essential));
          const essentialControl = <select aria-label={`Requirement ${index + 1} essential`} className={`${selectClass} min-h-11`}
            value={row.essential ? "yes" : "no"}
            onChange={event => changeRequirements(requirements.map(item => item.id === row.id
              ? { ...item, essential: event.target.value === "yes" } : item))}>
            <option value="yes">Yes</option><option value="no">No</option>
          </select>;
          const removeControl = <button type="button" className="min-h-11 border-2 border-line-muted px-2 text-13 underline disabled:opacity-50"
            aria-label={`Remove requirement ${index + 1}`} disabled={requirements.length === 1}
            onClick={() => changeRequirements(requirements.filter(item => item.id !== row.id))}>Remove</button>;
          return <tr key={row.id} className="border-t border-line-muted">
            <th scope="row" className="px-2 py-2 align-top font-normal"><select aria-label={`Requirement ${index + 1} rank`}
              className="min-h-11 w-full border-2 border-line-muted bg-bg text-center text-14 text-fg focus:border-line focus:outline-none" value={index + 1}
              onChange={event => changeRequirements(moveCvTargetingRequirement(requirements, row.id, Number(event.target.value)))}>
              {requirements.map((_, rank) => <option key={rank} value={rank + 1}>{rank + 1}</option>)}
            </select></th>
            <td className="min-w-0 px-2 py-2 align-top"><Textarea aria-label={`Requirement ${index + 1} text`} rows={1}
              data-requirement-id={row.id} maxLength={250}
              className="min-h-11" value={row.text}
              onChange={event => changeRequirements(requirements.map(item => item.id === row.id
                ? { ...item, text: event.target.value } : item))} />
              {(origin === "user" || customised) && <p className="mt-1 text-12 text-muted">{origin === "user" ? "Added by you" : "Edited for this CV"}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-2 md:hidden"><label className="min-w-20 flex-1 text-13">Essential{essentialControl}</label>{removeControl}</div>
            </td>
            <td className="hidden px-2 py-2 align-top md:table-cell">{essentialControl}</td>
            <td className="hidden px-2 py-2 align-top md:table-cell">{removeControl}</td>
          </tr>;
        })}</tbody>
      </table>
      <div className="flex flex-wrap items-center gap-3"><button type="button"
        className="min-h-11 border-2 border-line-muted px-3 text-13 font-medium disabled:opacity-50"
        disabled={requirements.length >= 30}
        onClick={() => { const id = `u:${crypto.randomUUID()}`; newRequirementToFocus.current = id;
          changeRequirements([...requirements, { id, text: "", essential: false }]); }}>
        Add requirement
      </button><p className="text-12 text-muted">{requirements.length}/30 requirements · keep at least one</p></div>
    </fieldset>
    {essentials.length > 0 && <fieldset className="space-y-2 border border-warning p-3" disabled={disabled}>
      <legend className="font-medium">Check essential requirements</legend>
      <p className="text-12">Your omitted entries are the mapped evidence for these essentials. Confirm each gap has been reviewed; Check will report the current coverage.</p>
      {essentials.map(item => <label key={item.id} className="flex gap-2 text-14"><input type="checkbox"
        checked={value.acknowledgedEssentialOmissionIds.includes(item.id)}
        onChange={event => onChange({ ...value, acknowledgedEssentialOmissionIds: event.target.checked
          ? [...value.acknowledgedEssentialOmissionIds, item.id] : value.acknowledgedEssentialOmissionIds.filter(id => id !== item.id) })} />
        <span>{item.label}</span></label>)}
    </fieldset>}
    <div className="flex flex-wrap gap-3 text-14">
      <label>Maximum pages <select aria-label="Maximum pages" className={selectClass} disabled={disabled} value={value.presentation.maxPages}
        onChange={event => onChange({ ...value, presentation: { ...value.presentation, maxPages: Number(event.target.value) as CvTargetingChoices["presentation"]["maxPages"] } })}>
        {[1, 2, 3, 4, 5].map(pages => <option key={pages} value={pages}>{pages} {pages === 1 ? "page" : "pages"}</option>)}
      </select></label>
      <label>Body size <select aria-label="Body size" className={selectClass} disabled={disabled} value={value.presentation.bodySizePt}
        onChange={event => onChange({ ...value, presentation: { ...value.presentation, bodySizePt: Number(event.target.value) as 11 | 12 } })}>
        <option value={12}>12 pt · recommended</option><option value={11}>11 pt · compact</option>
      </select></label>
    </div>
    <p className="text-12 text-muted">One or two pages suit most applications; this selected maximum is enforced for generation and finalisation. About 500–600 words is only a starting point for one page. Preview measures the actual PDF.</p>
    {view.summaryNeedsReview && <p className="text-12 text-warning">The summary may refer to omitted evidence. Review it before finalising.</p>}
  </section>;
}

/** A paused build has no editable wording, so confirmation uses its own fenced action. */
export function CvTargetingConfirmation({ view, blocked, recovery = false }: {
  view: CvTargetingView; blocked: string | null; recovery?: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState(() => initialCvTargetingChoices(view));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const request = useRef(crypto.randomUUID());
  const issue = cvTargetingChoiceIssue(view, value);
  function change(next: CvTargetingChoices) { setValue(next); setError(null); request.current = crypto.randomUUID(); }
  async function confirm() {
    if (inFlight.current || issue || blocked) return;
    inFlight.current = true; setPending(true); setError(null);
    try {
      const action = recovery ? reviseFailedCvTargeting : confirmCvTargetingPriorities;
      const result = await action(view.draftId, { expectedRevision: view.revision,
        expectedSource: view.source, expectedRubricKey: view.rubricKey, requestKey: request.current, choices: value });
      if (!result.ok) { setError(result.error); return; }
      router.push(result.destination); router.refresh();
    } catch { setError("Confirmation could not be checked. Try again; your choices are still here."); }
    finally { inFlight.current = false; setPending(false); }
  }
  return <div className="space-y-3"><CvTargetingControls view={view} value={value} onChange={change} disabled={pending || !!blocked} />
    {blocked && <p className="text-12 text-warning">{blocked}</p>}
    {issue && <p className="text-12 text-muted">{issue}</p>}
    {error && <p role="alert" className="text-14 text-danger">{error}</p>}
    <button type="button" className="border-2 border-accent bg-accent px-4 py-2 font-medium text-accent-fg disabled:opacity-50"
      disabled={!!blocked || !!issue || pending} onClick={confirm}>
      {pending ? "Confirming…" : recovery ? "Update choices and retry this CV" : "Confirm priorities and continue build"}</button></div>;
}
