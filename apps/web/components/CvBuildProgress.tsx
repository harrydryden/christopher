import type { ReactNode } from "react";
import { CV_BUILD_STAGES, type CvBuildStage } from "@ava/core";
import { Mark } from "./brand";
import { Badge, toneText } from "./Badge";
import { relativeTime } from "@/lib/format";
import { CV_STAGE_LABELS } from "@/lib/cv-build-narrative";
import type { CvBuildState } from "@/lib/cv-build-state";

/**
 * The four the strip shows. `preparing` and `publishing` are the moments either side of a build,
 * over in seconds, and a milestone nobody ever sees lit is noise.
 */
type CvMilestone = Exclude<CvBuildStage, "preparing" | "publishing">;
const MILESTONE_DETAILS: Record<CvMilestone, string> = {
  analysing:
    "Reading the company’s requirements and matching your confirmed evidence.",
  writing:
    "Choosing relevant achievements and writing to the content budget for your page limit.",
  fitting:
    "Measuring the actual PDF and prioritising the strongest content within your page limit, keeping every job and qualification.",
  assessing:
    "Checking the optimised wording against your evidence and the company’s job description.",
};

/**
 * The milestones in the order a build runs them, named as the narrative names them: the strip and
 * the lines beneath it label one stage one way, so a line can be traced to the card above it.
 */
const stages = CV_BUILD_STAGES.filter(
  (stage): stage is CvMilestone => stage in MILESTONE_DETAILS,
).map((id) => ({ id, title: CV_STAGE_LABELS[id], detail: MILESTONE_DETAILS[id] }));

/**
 * A build is a chain of model calls that can honestly take twenty minutes, so a turning mark says
 * nothing. What the reader needs is when it started, what it is doing, when it last moved, and
 * which attempt this is — and, when it has stopped moving, to be told so rather than left watching.
 *
 * The milestone strip is the shape of a build; the narrative below it is what is actually
 * happening inside the milestone, motion by motion, so a reader watching "Optimise" for four
 * minutes can see the measuring and the trimming that make it up.
 */
export function CvBuildProgress({
  stage,
  queued,
  build,
  startedAt,
  now,
  narrative,
  action,
}: {
  stage: string | null;
  queued: boolean;
  build: CvBuildState;
  startedAt: Date;
  now: Date;
  /** The motions of this build so far, under the strip. */
  narrative?: ReactNode;
  /** The way out of a stopped build, when there is one.  */
  action?: ReactNode;
}) {
  const index = queued ? -1 : stages.findIndex((item) => item.id === stage);
  const active = stages[index];
  const stopped = build.phase === "stopped";
  const retrying = build.phase === "retrying";
  const tone = build.tone;
  return (
    <section
      aria-label="CV build progress"
      aria-busy={stopped ? undefined : "true"}
      className="space-y-6 border-2 border-line bg-raised p-5 sm:p-6"
    >
      <div className="flex items-center gap-5">
        <Mark size={48} searching={!stopped} className="shrink-0" />
        <div role="status" aria-live="polite" aria-atomic="true" className="min-w-0 space-y-1">
          <h2 className="ds-pixel text-16 text-fg">
            {stopped
              ? "This build stopped"
              : active?.title ?? (queued ? "Your CV is queued" : "Preparing your CV")}
          </h2>
          <p className={`text-14 ${toneText(tone)}`}>{build.message}</p>
          <p className="text-12 text-muted">
            Started {relativeTime(startedAt, now)}
            {build.phase !== "waiting" && <> · last progress {relativeTime(build.lastProgressAt, now)}</>}
            {build.attempts !== null && build.maxAttempts !== null && (
              <> · attempt {build.attempts} of {build.maxAttempts}</>
            )}
          </p>
          {stopped && build.taskError && (
            <p className="text-12 text-muted" title={build.taskError}>
              The queue recorded: {build.taskError}
            </p>
          )}
        </div>
        {(stopped || retrying || build.phase === "stalled") && (
          <Badge tone={tone} className="ml-auto shrink-0">
            {stopped ? "stopped" : retrying ? "retrying" : "no progress"}
          </Badge>
        )}
      </div>
      <ol className="grid gap-3 sm:grid-cols-4" aria-label="Build stages">
        {stages.map((item, i) => (
          <li
            key={item.id}
            aria-current={i === index ? "step" : undefined}
            className={`border-2 p-3 text-14 ${i === index && !stopped ? "border-line bg-sunken text-fg" : "border-line-muted text-muted"}`}
          >
            <span
              className={`ds-pixel mb-2 inline-flex size-6 items-center justify-center text-10 ${i <= index ? "bg-accent text-accent-fg" : "bg-track text-muted"}`}
              aria-hidden="true"> {i < index ? "✓" : i + 1}
            </span>
            <p className="font-medium">{item.title}</p>
            <span className="sr-only">
              {i < index
                ? "Completed": i === index ? "In progress": "Waiting"}
            </span>
          </li>
        ))}
      </ol>
      {active && !stopped && <p className="text-14 text-muted">{active.detail}</p>}
      {narrative}
      {action}
    </section>
  );
}
