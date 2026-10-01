"use client";

import { useRef, useState } from "react";
import { answerOpenQuestionSetting } from "@/app/actions/learning";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { SettingsForm } from "@/components/SettingsForm";
import type { ActionResult } from "@/lib/validation";

type Question = { id: string; question: string; answer?: string };
type Draft = { question: string; profileVersion: number; answer: string; savedAnswer?: string };

export function OpenQuestionEditors({ questions, profileVersion, isLatest, disabled }: {
  questions: Question[];
  profileVersion: number;
  isLatest: boolean;
  disabled: boolean;
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [confirmedAnswers, setConfirmedAnswers] = useState<Record<string, { question: string; answer: string }>>({});
  const editVersion = useRef<Record<string, number>>({});
  const visible: Question[] = [
    ...questions,
    ...Object.entries(drafts).filter(([id]) => !questions.some(question => question.id === id))
      .map(([id, draft]) => ({ id, question: draft.question })),
    ...Object.entries(confirmedAnswers).filter(([id]) => !questions.some(question => question.id === id) && !drafts[id])
      .map(([id, saved]) => ({ id, question: saved.question, answer: saved.answer })),
  ];

  if (!visible.length) return <EmptyState title="No open questions" description="Questions about your decisions appear here." />;

  return <div className="space-y-3">
    {visible.map(question => {
      const draft = drafts[question.id];
      const standingAnswer = question.answer ?? confirmedAnswers[question.id]?.answer ?? draft?.savedAnswer;
      const editable = Boolean(draft) || (!standingAnswer && isLatest);
      const version = draft?.profileVersion ?? profileVersion;
      async function save(previous: ActionResult, data: FormData): Promise<ActionResult> {
        const submittedEdit = editVersion.current[question.id] ?? 0;
        const submittedAnswer = String(data.get("answer") ?? "").trim();
        const result = await answerOpenQuestionSetting(question.id, previous, data);
        if (result.ok) {
          setConfirmedAnswers(current => ({ ...current, [question.id]: { question: draft?.question ?? question.question, answer: submittedAnswer } }));
          setDrafts(current => {
            const newerDraft = current[question.id];
            if ((editVersion.current[question.id] ?? 0) !== submittedEdit && newerDraft) {
              return { ...current, [question.id]: { ...newerDraft, profileVersion: Number(result.nextSnapshot?.profileVersion ?? version), savedAnswer: submittedAnswer } };
            }
            const next = { ...current };
            delete next[question.id];
            return next;
          });
        }
        return result;
      }
      return <div key={question.id} className="border border-line-muted p-3 text-14">
        <p className="mb-1.5 text-fg">{draft?.question ?? question.question}</p>
        {standingAnswer && <p className="mb-2 text-muted"><span className="font-medium">Answered: </span>{standingAnswer}</p>}
        {editable ? <SettingsForm action={save} resetOnSuccess={false} submitLabel="Save answer" submitDisabled={disabled}
          secondaryActions={draft && <Button type="button" size="sm" onClick={() => setDrafts(current => {
            const next = { ...current };
            delete next[question.id];
            return next;
          })}>Discard draft</Button>}>
          <fieldset disabled={disabled} className="flex min-w-0 flex-1 flex-col items-stretch gap-2 sm:flex-row sm:items-end">
            <input type="hidden" name="profileVersion" value={version} />
            <label htmlFor={`answer-${question.id}`} className="sr-only">Answer: {draft?.question ?? question.question}</label>
            <input id={`answer-${question.id}`} name="answer" required placeholder="Your answer…" value={draft?.answer ?? ""}
              onChange={event => {
                const answer = event.target.value;
                editVersion.current[question.id] = (editVersion.current[question.id] ?? 0) + 1;
                setDrafts(current => ({ ...current, [question.id]: { question: draft?.question ?? question.question, profileVersion: draft?.profileVersion ?? profileVersion, answer } }));
              }}
              className="w-full min-w-0 flex-1 border border-line-muted px-2 py-1 text-14 outline-none focus:border-line" />
          </fieldset>
        </SettingsForm> : standingAnswer ? null
          : <p className="text-12 text-muted">Answer on the latest profile.</p>}
      </div>;
    })}
  </div>;
}
