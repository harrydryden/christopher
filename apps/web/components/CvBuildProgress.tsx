import type { ReactNode } from "react";
import { Mark } from "./brand";
import { Badge, toneText } from "./Badge";
import { Elapsed } from "./Elapsed";
import { CV_MILESTONES, CV_STAGE_LABELS, cvStalledMessage, type CvMilestone } from "@/lib/cv-build-narrative";
import type { CvProgressBuild } from "@/lib/cv-progress-types";

/**
 * A build is a chain of model calls that can honestly take twenty minutes, so a turning mark says
 * nothing. What the reader needs is when it started, what it is doing, when it last moved, and
 * which attempt this is — and, when it has stopped moving, to be told so rather than left watching.
 *
 * The milestone strip is the shape of a build; the line under it says what is happening now, and
 * the narrative below that is every motion of it. Rendered in the browser from the progress feed,
 * so the elapsed figures count on their own and nothing here waits for a server render.
 */
export function CvBuildProgress({
  milestone,
  queued,
  build,
  startedAt,
  now,
  current,
  progress,
  narrative,
  action,
}: {
  /** The milestone the build is in, from its motions; `publishing` has passed all four. */
  milestone: CvMilestone | "publishing" | null;
  queued: boolean;
  build: CvProgressBuild;
  startedAt: string;
  now: number;
  /** "What is happening now", from `currentMotionLine`. */
  current: string | null;
  /** "Stage 3 of 4 · 3 of 5 batches done · about 2 min left", from `cvBuildProgressLine`. */
  progress: string | null;
  narrative?: ReactNode;
  action?: ReactNode;
}) {
  const index = queued || !milestone ? -1 : milestone === "publishing" ? CV_MILESTONES.length : CV_MILESTONES.indexOf(milestone);
  const active = index >= 0 && index < CV_MILESTONES.length ? CV_MILESTONES[index] : undefined;
  const stopped = build.phase === "stopped";
  const retrying = build.phase === "retrying";
  const tone = build.tone;
  // A build that has not moved for ten minutes keeps counting the minutes between readings.
  const message = build.phase === "stalled" ? cvStalledMessage(now - new Date(build.lastProgressAt).getTime()) : build.message;
  return (
    <section aria-label="CV build progress" aria-busy={stopped ? undefined : "true"} className="space-y-6 border-2 border-line bg-raised p-5 sm:p-6">
      <div className="flex items-center gap-5">
        <Mark size={48} searching={!stopped} className="shrink-0 text-brand" />
        <div role="status" aria-live="polite" aria-atomic="true" className="min-w-0 space-y-1">
          <h2 className="ds-pixel text-16 text-fg">
            {stopped
              ? "This build stopped"
              : active
                ? CV_STAGE_LABELS[active]
                : milestone === "publishing"
                  ? CV_STAGE_LABELS.publishing
                  : queued
                    ? "Your CV is queued"
                    : "Preparing your CV"}
          </h2>
          <p className={`text-14 ${toneText(tone)}`}>{message}</p>
          <p className="text-12 text-muted">
            Started <Elapsed since={startedAt} now={now} relative />
            {build.phase !== "waiting" && (
              <>
                {" "}· last progress <Elapsed since={build.lastProgressAt} now={now} relative />
              </>
            )}
            {build.attempts !== null && build.maxAttempts !== null && (
              <>
                {" "}· attempt {build.attempts} of {build.maxAttempts}
              </>
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
        {CV_MILESTONES.map((id, i) => (
          <li
            key={id}
            aria-current={i === index ? "step" : undefined}
            className={`border-2 p-3 text-14 ${i === index && !stopped ? "border-line bg-sunken text-fg" : "border-line-muted text-muted"}`}
          >
            <span
              className={`ds-pixel mb-2 inline-flex size-6 items-center justify-center text-10 ${i <= index ? "bg-accent text-accent-fg" : "bg-track text-muted"}`}
              aria-hidden="true"
            >
              {i < index ? "✓" : i + 1}
            </span>
            <p className="font-medium">{CV_STAGE_LABELS[id]}</p>
            <span className="sr-only">{i < index ? "Completed" : i === index ? "In progress" : "Waiting"}</span>
          </li>
        ))}
      </ol>
      {!stopped && (current || progress) && (
        <div className="space-y-1" aria-live="polite">
          {current && <p className="text-14">{current}</p>}
          {progress && <p className="text-12 text-muted">{progress}</p>}
        </div>
      )}
      {narrative}
      {action}
    </section>
  );
}
