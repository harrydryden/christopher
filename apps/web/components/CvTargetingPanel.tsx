"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CvTargetingChoices, CvTargetingView } from "@col/core/cv-targeting";
import { confirmCvTargetingPriorities, reviseFailedCvTargeting } from "@/app/actions/cv-targeting";
import { selectClass } from "@/components/Field";
import { affectedCvTargetingEssentials, cvTargetingChoiceIssue, initialCvTargetingChoices,
  normaliseCvTargetingChoices } from "@/lib/cv-targeting-choices";
export { cvTargetingChoiceIssue, initialCvTargetingChoices, normaliseCvTargetingChoices } from "@/lib/cv-targeting-choices";

/** Browser-safe controls. Labels and rubric come from an account-scoped server view. */
export function CvTargetingControls({ view, value, onChange, disabled = false }: {
  view: CvTargetingView; value: CvTargetingChoices; onChange: (next: CvTargetingChoices) => void; disabled?: boolean;
}) {
  const essentials = affectedCvTargetingEssentials(view, value);
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
      <p className="text-12 text-muted">Choose three to five priorities, or all available when fewer than three were identified. Every essential remains in the assessment.</p>
      {view.priorities.map(item => <label key={item.id} className="flex gap-2 text-14"><input type="checkbox"
        checked={value.emphasisRequirementIds.includes(item.id)}
        onChange={event => onChange({ ...value, emphasisRequirementIds: event.target.checked
          ? [...value.emphasisRequirementIds, item.id] : value.emphasisRequirementIds.filter(id => id !== item.id) })} />
        <span>{item.label}{item.importance === "essential" ? " · essential" : ""}</span></label>)}
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
