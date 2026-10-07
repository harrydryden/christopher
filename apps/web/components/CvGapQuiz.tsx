"use client";

import { useRef, useState } from "react";
import type { ActionResult } from "@/lib/validation";
import type { GapQuizForm, GapQuizLibrary } from "@/lib/cv-gap-quiz-library";
import { Button } from "@/components/Button";
import { Select } from "@/components/Field";
import { EvidenceConversation } from "@/components/EvidenceConversation";
import type { EvidenceDraftView } from "@/app/actions/evidence";

const INITIAL: ActionResult = { ok: true };

/**
 * The deliberate human checkpoint: optional answers, explicit destination and factual confirmation.
 *
 * `quiz` and `library` are shaped on the server (lib/cv-gap-quiz-library.ts): the destinations an
 * answer can be saved under and the one each question starts on, not the Library itself.
 */
export function CvGapQuiz({
  quiz,
  library,
  action,
  draftId,
  openDrafts = [],
  scopeId,
}: {
  quiz: GapQuizForm;
  library: GapQuizLibrary;
  action: (state: ActionResult, form: FormData) => Promise<ActionResult>;
  draftId: string;
  openDrafts?: EvidenceDraftView[];
  scopeId: string;
}) {
  const busy = useRef(false);
  const [state, setState] = useState<ActionResult>(INITIAL);
  const [pending, setPending] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [destinations, setDestinations] = useState<Record<string, string>>({});
  return (
    <section aria-labelledby="gap-quiz-title" className="space-y-5 border-2 border-line bg-raised p-4 sm:p-6">
      <header className="space-y-2">
        <p className="ds-label text-info">Optional evidence check</p>
        <h2 id="gap-quiz-title" className="text-18 font-semibold">Could your Experience say more?</h2>
        <p className="max-w-3xl text-14 text-muted">
          The role asks for evidence that your Experience does not yet show clearly. Add only facts you know are accurate.
          Your confirmed wording will be saved to Experience and reused in future CVs. You can continue without adding anything.
        </p>
      </header>
      <form method="post" className="space-y-5" onSubmit={async event => {
        event.preventDefault();
        if (busy.current) return;
        busy.current = true;
        setPending(true);
        try {
          const submitter = (event.nativeEvent as SubmitEvent).submitter;
          const result = await action(state, new FormData(event.currentTarget, submitter));
          const destination = result.ok && result.message?.match(/^cv-gap-destination:(\/cv\/[0-9a-f-]{36})$/)?.[1];
          if (destination) {
            window.location.assign(destination);
            return;
          }
          setState(result);
        } catch {
          setState({ ok: false, error: "This CV could not be continued. Your entries are still here; please try again." });
        }
        busy.current = false;
        setPending(false);
      }}>
        <ol className="space-y-4" aria-label="Evidence questions">
          {quiz.questions.map((question, index) => {
            const destination = destinations[question.id] ?? question.destinationValue;
            const [kind, destinationId] = destination.split(":");
            return (
              <li key={question.id} className="space-y-3 border border-line-muted bg-bg p-4">
                <div className="space-y-1">
                  <p className="ds-label">Question {index + 1} of {quiz.questions.length}</p>
                  <p className="text-12 text-muted">Role requirement: {question.requirement}</p>
                  <p className="text-14 font-medium text-fg">{question.prompt}</p>
                </div>
                <label className="flex flex-col gap-1.5 text-14">
                  <span className="ds-label">Save this evidence under</span>
                  <Select name={`destination:${question.id}`} value={destination} onChange={event => { setDestinations(current => ({ ...current, [question.id]: event.target.value })); setAnswers(current => { const next = { ...current }; delete next[question.id]; return next; }); }}>
                    {library.employment.map(job => (
                      <option key={`employment:${job.id}`} value={`employment:${job.id}`}>{job.jobTitle} · {job.company}</option>
                    ))}
                    {library.entries.map(entry => (
                      <option key={`evidence:${entry.id}`} value={`evidence:${entry.id}`}>{entry.heading}</option>
                    ))}
                  </Select>
                </label>
                <EvidenceConversation key={`${question.id}:${destination}`} source="cv_quiz" sourceId={draftId}
                  question={question.prompt} questionId={question.id} baseVersion={quiz.libraryVersion}
                  destination={{ kind: kind === "employment" ? "employment" : "evidence", id: destinationId ?? "" }}
                  destinationLabel={kind === "employment" ? library.employment.find(item => item.id === destinationId)?.jobTitle ?? "the selected job" : library.entries.find(item => item.id === destinationId)?.heading ?? "the selected entry"}
                  scopeId={scopeId}
                  initialDraft={openDrafts.find(item => item.questionId === question.id && item.destination.kind === kind && item.destination.id === destinationId)}
                  onConfirmed={wording => setAnswers(current => ({ ...current, [question.id]: wording }))} />
                {answers[question.id] && <><input type="hidden" name={`answer:${question.id}`} value={answers[question.id]} /><input type="hidden" name={`confirmed:${question.id}`} value="on" /><p role="status" className="text-12 text-ok">Reviewed wording ready to save with this CV.</p></>}
              </li>
            );
          })}
        </ol>
        {!state.ok && <p role="alert" className="text-14 text-danger">{state.error}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" name="decision" value="confirm" variant="primary" disabled={pending}>
            {pending ? "Continuing…" : "Save evidence and continue"}
          </Button>
          <Button type="submit" name="decision" value="skip" variant="secondary" formNoValidate disabled={pending}>
            No further evidence — continue
          </Button>
        </div>
        <p className="text-12 text-muted">This build will resume from its completed role analysis; it will not repeat these questions.</p>
      </form>
    </section>
  );
}
