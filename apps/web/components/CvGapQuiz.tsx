"use client";

import { useRef, useState } from "react";
import type { ActionResult } from "@/lib/validation";
import type { GapQuizForm, GapQuizLibrary } from "@/lib/cv-gap-quiz-library";
import { Button } from "@/components/Button";
import { Select } from "@/components/Field";
import type { EvidenceDraftView } from "@/app/actions/evidence";

const INITIAL: ActionResult = { ok: true };

/**
 * Optional direct facts, with a destination the person chooses for each answer.
 *
 * `quiz` and `library` are shaped on the server (lib/cv-gap-quiz-library.ts): the destinations an
 * answer can be saved under and the one each question starts on, not the Library itself.
 */
export function CvGapQuiz({
  quiz,
  library,
  action,
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
          Your own answer is ready to use once saved to Experience. You can continue without adding anything.
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
            return (
              <li key={question.id} className="space-y-3 border border-line-muted bg-bg p-4">
                <div className="space-y-1">
                  <p className="ds-label">Question {index + 1} of {quiz.questions.length}</p>
                  <p className="text-12 text-muted">Role requirement: {question.requirement}</p>
                  <p className="text-14 font-medium text-fg">{question.prompt}</p>
                </div>
                <label className="flex flex-col gap-1.5 text-14">
                  <span className="ds-label">Save this evidence under</span>
                  <Select name={`destination:${question.id}`} value={destination} onChange={event => setDestinations(current => ({ ...current, [question.id]: event.target.value }))}>
                    {library.employment.map(job => (
                      <option key={`employment:${job.id}`} value={`employment:${job.id}`}>{job.jobTitle} · {job.company}</option>
                    ))}
                    {library.entries.map(entry => (
                      <option key={`evidence:${entry.id}`} value={`evidence:${entry.id}`}>{entry.heading}</option>
                    ))}
                  </Select>
                </label>
                <label className="grid gap-1.5 text-14"><span className="ds-label">Your answer (optional)</span>
                  <textarea className="min-h-24 w-full border border-line-muted bg-bg p-3 text-14" maxLength={2000}
                    name={`answer:${question.id}`} value={answers[question.id] ?? ""}
                    onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))}
                    placeholder="Describe what you did or achieved in your own words." /></label>
              </li>
            );
          })}
        </ol>
        {!state.ok && <p role="alert" className="text-14 text-danger">{state.error}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" name="decision" value="confirm" variant="primary" disabled={pending}>
            {pending ? "Continuing…" : "Save facts and continue"}
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
