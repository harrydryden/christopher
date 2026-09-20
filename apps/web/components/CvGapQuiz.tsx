"use client";

import { useActionState, useState } from "react";
import type { CvGapQuiz as CvGapQuizValue, CvLibrary } from "@christopher/core";
import type { ActionResult } from "@/lib/validation";
import { Button } from "@/components/Button";
import { Checkbox, Select, Textarea } from "@/components/Field";

const INITIAL: ActionResult = { ok: true };

export function gapDestinationValue(
  destination: CvGapQuizValue["questions"][number]["suggestedDestination"],
  library: CvLibrary,
) {
  if (destination.kind === "employment") return `employment:${destination.employmentId}`;
  const entry = library.entries.find(item => item.id === destination.entryId);
  return entry?.kind === "experience" && entry.employmentId
    ? `employment:${entry.employmentId}`
    : `evidence:${destination.entryId}`;
}

/** The deliberate human checkpoint: optional answers, explicit destination and factual confirmation. */
export function CvGapQuiz({
  quiz,
  library,
  action,
}: {
  quiz: CvGapQuizValue;
  library: CvLibrary;
  action: (state: ActionResult, form: FormData) => Promise<ActionResult>;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // Structured experience is consolidated for generation and can carry a synthetic/grouped ID;
  // employment is its stable editable destination. Legacy unlinked experience keeps its real ID.
  const evidence = library.entries.filter(entry => (!entry.status || entry.status === "active") && (entry.kind !== "experience" || !entry.employmentId));
  return (
    <section aria-labelledby="gap-quiz-title" className="space-y-5 border-2 border-line bg-raised p-4 sm:p-6">
      <header className="space-y-2">
        <p className="ds-label text-info">Optional evidence check</p>
        <h2 id="gap-quiz-title" className="ds-pixel text-16">Could your Library say more?</h2>
        <p className="max-w-3xl text-14 text-muted">
          The role asks for evidence that your Library does not yet show clearly. Add only facts you know are accurate.
          Your confirmed answers will be saved to a new Library version and reused in future CVs. You can continue without adding anything.
        </p>
      </header>
      <form action={formAction} className="space-y-5">
        <ol className="space-y-4" aria-label="Evidence questions">
          {quiz.questions.map((question, index) => {
            const answered = !!answers[question.id]?.trim();
            return (
              <li key={question.id} className="space-y-3 border border-line-muted bg-bg p-4">
                <div className="space-y-1">
                  <p className="ds-label">Question {index + 1} of {quiz.questions.length}</p>
                  <p className="text-12 text-muted">Role requirement: {question.requirement}</p>
                  <label htmlFor={`gap-answer-${index}`} className="block text-14 font-medium text-fg">{question.prompt}</label>
                </div>
                <Textarea
                  id={`gap-answer-${index}`}
                  name={`answer:${question.id}`}
                  maxLength={2_000}
                  rows={3}
                  value={answers[question.id] ?? ""}
                  onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))}
                  placeholder="Leave blank if you do not have further evidence"
                />
                <label className="flex flex-col gap-1.5 text-14">
                  <span className="ds-label">Save this evidence under</span>
                  <Select name={`destination:${question.id}`} defaultValue={gapDestinationValue(question.suggestedDestination, library)} disabled={!answered}>
                    {(library.employment ?? []).map(job => (
                      <option key={`employment:${job.id}`} value={`employment:${job.id}`}>{job.jobTitle} · {job.company}</option>
                    ))}
                    {evidence.map(entry => (
                      <option key={`evidence:${entry.id}`} value={`evidence:${entry.id}`}>{entry.heading}</option>
                    ))}
                  </Select>
                </label>
                <Checkbox
                  name={`confirmed:${question.id}`}
                  required={answered}
                  disabled={!answered}
                  label="I confirm this wording is accurate and belongs under the selected Library entry."
                />
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
