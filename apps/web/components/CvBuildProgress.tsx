import type { ReactNode } from "react";
import { Mark } from "./brand";
import { Badge, toneText } from "./Badge";
import { relativeTime } from "@/lib/format";
import type { CvBuildState } from "@/lib/cv-build-state";

const stages = [
  {
    id: "analysing",
    title: "Understand the role",
    detail:
      "Reading the company’s requirements and matching your confirmed evidence.",
  },
  {
    id: "writing",
    title: "Write your CV",
    detail:
      "Choosing relevant achievements and writing to the content budget for your page limit.",
  },
  {
    id: "fitting",
    title: "Optimise",
    detail:
      "Measuring the actual PDF and prioritising the strongest content within your page limit, keeping every job and qualification.",
  },
  {
    id: "assessing",
    title: "Check and score",
    detail:
      "Checking the optimised wording against your evidence and the company’s job description.",
  },
];

/**
 * A build is a chain of model calls that can honestly take twenty minutes, so a turning wheel says
 * nothing. What the reader needs is when it started, what it is doing, when it last moved, and
 * which attempt this is — and, when it has stopped moving, to be told so rather than left watching.
 */
export function CvBuildProgress({
  stage,
  queued,
  build,
  startedAt,
  now,
  action,
}: {
  stage: string | null;
  queued: boolean;
  build: CvBuildState;
  startedAt: Date;
  now: Date;
  /** The way out of a stopped build, when there is one.  */
  action?: ReactNode;
}) {
  const index = queued ? -1 : stages.findIndex((item) => item.id === stage);
  const active = stages[index];
  const stopped = build.phase === "stopped";
  const tone = stopped ? "red" : build.phase === "stalled" ? "amber" : "blue";
  return (
    <section
      aria-label="CV build progress"
      aria-busy={stopped ? undefined : "true"}
      className="space-y-6 border-2 border-line bg-raised p-5 sm:p-6"
    >
      <div className="flex items-center gap-5">
        <Mark size={64} searching={!stopped} className="shrink-0" />
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
        {(stopped || build.phase === "stalled") && <Badge tone={tone} className="ml-auto shrink-0">{stopped ? "stopped" : "no progress"}</Badge>}
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
      {action}
    </section>
  );
}
