import type { CvBuildStepView } from "@ava/core";
import { Badge } from "./Badge";
import { CvDisclosure } from "./CvDisclosure";
import {
  attemptLabel,
  cvBuildTotals,
  cvBuildTotalsLine,
  narrateStep,
  type NarrativeContext,
} from "@/lib/cv-build-narrative";

/** The glyph says nothing to a screen reader; this is what it means. */
const SPOKEN: Record<CvBuildStepView["status"], string> = {
  running: "in progress",
  done: "done",
  failed: "failed",
  skipped: "skipped",
};

/**
 * A build's motions as they happen, newest last: one line each, present tense while a motion is
 * open and past tense once it has closed, with the figures it recorded and what it cost.
 *
 * The milestone strip above says which of the four stages a build has reached; this says what it
 * is actually doing inside that stage, which is the difference between "Optimise" for four minutes
 * and "Measured 3 pages against a limit of 2 · Trimming lower-priority wording to fit".
 *
 * A running motion's elapsed figure is rendered from `now`, and the page's poll refreshes at least
 * once a minute while anything is open, so it keeps moving without a timer on the client.
 */
export function CvBuildNarrative({
  steps,
  now,
  maxAttempts = null,
  context,
}: {
  steps: CvBuildStepView[];
  now: Date;
  /** The queue's allowance, for the "Attempt 2 of 3" divider. */
  maxAttempts?: number | null;
  context?: NarrativeContext;
}) {
  if (!steps.length) return null;
  const attempts = new Set(steps.map((step) => step.attempt));
  let attempt = steps[0]!.attempt;
  return (
    <ol aria-label="Build narrative" className="space-y-0.5">
      {steps.map((step) => {
        const narrated = narrateStep(step, now, context);
        // Every later attempt is announced, so a line that repeats a motion is not read as a loop.
        const divider = attempts.size > 1 && step.attempt !== attempt;
        attempt = step.attempt;
        return (
          <li key={step.id} className="text-14">
            {divider && (
              <p className="ds-divider ds-pixel mt-3 pb-2 text-10 text-muted">
                {attemptLabel(step.attempt, maxAttempts)}
              </p>
            )}
            <div className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5 py-1">
              <span className="text-12 text-muted">{narrated.time}</span>
              <Badge tone={narrated.tone} title={SPOKEN[narrated.status]}>
                <span aria-hidden="true">{narrated.glyph}</span>
                <span className="sr-only">{SPOKEN[narrated.status]}</span>
              </Badge>
              <div className="min-w-0 space-y-0.5">
                <p className="break-words" title={narrated.hint ?? undefined}>
                  {narrated.text}
                  {narrated.meta && <span className="text-muted"> · {narrated.meta}</span>}
                </p>
                {narrated.note && (
                  <p className={`text-12 break-words ${narrated.status === "failed" ? "text-danger" : "text-muted"}`}>
                    {narrated.note}
                  </p>
                )}
                <p className="ds-label">{narrated.stage}</p>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The same narrative after the build, kept on the Content tab behind a disclosure so "why did this
 * build cost $3.40" and "what did it actually do" stay answerable from the page rather than from
 * the worker's logs, which do not live that long.
 */
export function CvBuildLog({
  steps,
  now,
  maxAttempts = null,
  context,
}: {
  steps: CvBuildStepView[];
  now: Date;
  maxAttempts?: number | null;
  context?: NarrativeContext;
}) {
  if (!steps.length) return null;
  return (
    <section className="space-y-3 border-2 border-line bg-raised p-4">
      <CvDisclosure label="build log">
        <p className="text-14 text-muted">{cvBuildTotalsLine(cvBuildTotals(steps, now))}</p>
        <CvBuildNarrative steps={steps} now={now} maxAttempts={maxAttempts} context={context} />
      </CvDisclosure>
    </section>
  );
}
