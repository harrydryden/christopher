"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { decideCvPendingSkill } from "@/app/actions/cv-pending-skills";
import type { CvPendingSkillView } from "@/lib/cv-pending-skills-view";

type Proposal = CvPendingSkillView["proposals"][number];

function SkillDecision({ view, proposal }: { view: CvPendingSkillView; proposal: Proposal }) {
  const router = useRouter();
  const [mode, setMode] = useState<"link_existing" | "new_confirmed_row">("link_existing");
  const [evidenceId, setEvidenceId] = useState("");
  const [destinationId, setDestinationId] = useState("");
  const [example, setExample] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestKey = useRef<string | null>(null);
  const inFlight = useRef(false);
  const rotate = () => { requestKey.current = null; setError(null); };
  const changeEvidence = () => { rotate(); setConfirmed(false); };
  const canAccept = confirmed && (mode === "link_existing" ? !!evidenceId
    : !!destinationId && example.trim().length >= 12 && example.trim().length <= 1000);

  async function decide(decision: "accept" | "reject") {
    if (inFlight.current || (decision === "accept" && !canAccept)) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    requestKey.current ??= crypto.randomUUID();
    try {
      const result = await decideCvPendingSkill(view.draftId, proposal.id, {
        decision, expectedRevision: view.revision, requestKey: requestKey.current,
        ...(decision === "accept" ? { confirmFactual: true as const,
          evidence: mode === "link_existing"
            ? { kind: "link_existing" as const, evidenceEntryId: evidenceId }
            : { kind: "new_confirmed_row" as const, destinationEntryId: destinationId, factualExample: example.trim() } } : {}),
      });
      if (!result.ok) { setError(result.error); return; }
      router.push(result.destination);
      router.refresh();
    } catch { setError("We could not confirm this decision. Try again; your choices are still here."); }
    finally { inFlight.current = false; setPending(false); }
  }

  return <li className="space-y-3 border border-line-muted p-3 text-14">
    <div><strong>{proposal.label}</strong> · {proposal.category}
      <p className="text-12 text-muted">{proposal.origin === "user" ? "You entered this label in the CV." : "Suggested during the CV build."} It is not confirmed Experience until you choose a factual source.</p></div>
    <fieldset disabled={pending} className="space-y-2"><legend className="font-medium">If this skill is factual, show how you used it</legend>
      <label className="flex gap-2"><input type="radio" checked={mode === "link_existing"} onChange={() => { setMode("link_existing"); changeEvidence(); }} />Link an existing confirmed example</label>
      {mode === "link_existing" && <select aria-label={`Confirmed example for ${proposal.label}`} value={evidenceId}
        onChange={event => { setEvidenceId(event.target.value); changeEvidence(); }} className="w-full border border-line-muted p-2">
        <option value="">Choose an example</option>{view.eligibleEvidenceRows.map(row =>
          <option key={row.id} value={row.id}>{row.text}</option>)}</select>}
      <label className="flex gap-2"><input type="radio" checked={mode === "new_confirmed_row"} onChange={() => { setMode("new_confirmed_row"); changeEvidence(); }} />Add my own confirmed example</label>
      {mode === "new_confirmed_row" && <div className="space-y-2">
        <select aria-label={`Experience role for ${proposal.label}`} value={destinationId}
          onChange={event => { setDestinationId(event.target.value); changeEvidence(); }} className="w-full border border-line-muted p-2">
          <option value="">Choose the role where you used it</option>{view.eligibleDestinations.map(item =>
            <option key={item.entryId} value={item.entryId}>{item.heading}</option>)}</select>
        <label className="block">What did you do, in what context, and with what result?
          <textarea value={example} maxLength={1000} onChange={event => { setExample(event.target.value); changeEvidence(); }}
            className="mt-1 min-h-24 w-full border border-line-muted p-2" /></label>
      </div>}
      <label className="flex gap-2"><input type="checkbox" checked={confirmed} onChange={event => { setConfirmed(event.target.checked); rotate(); }} />I confirm this example is factual and belongs to my Experience.</label>
    </fieldset>
    {error && <p role="alert" className="text-danger">{error}</p>}
    <div className="flex flex-wrap gap-2"><button type="button" onClick={() => decide("accept")}
      disabled={pending || !canAccept} className="border border-accent px-3 py-2 disabled:opacity-50">Accept into Experience and this CV</button>
      <button type="button" onClick={() => decide("reject")} disabled={pending}
        className="border px-3 py-2 disabled:opacity-50">Reject suggestion</button></div>
  </li>;
}

/** Decisions use a saved revision; an unsaved Write edit is never silently discarded. */
export function CvPendingSkillPanel({ view }: { view: CvPendingSkillView | null }) {
  if (!view?.proposals.length) return null;
  return <section className="space-y-3 border border-line-muted p-4"><h2 className="text-18 font-semibold">Skills to confirm</h2>
    <p className="text-14">These labels are opportunities, not verified claims. Save any Write changes before deciding here. Accepting a skill adds it to your Experience and creates a new saved CV revision; Check that revision again before finalising.</p>
    <ul className="space-y-3">{view.proposals.map(proposal => <SkillDecision key={proposal.id} view={view} proposal={proposal} />)}</ul>
  </section>;
}
