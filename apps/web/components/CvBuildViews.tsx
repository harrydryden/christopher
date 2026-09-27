"use client";
/**
 * Everything on the CV page that tells a build in words: the build screen, the line saying what
 * the improvement pass is doing, and the build log. Each is a view of what `CvBuildLive` holds
 * (the ledger's steps, the reading, the clock), and all of them need the narrative
 * (lib/cv-build-narrative.ts), the largest thing the page would otherwise download.
 *
 * So this module is loaded only through `next/dynamic` in `CvBuildLive`: a building CV renders
 * the screen at once, on the server too, and fetches this chunk with the page; a finished CV, the
 * page nearly every visit sees, fetches it only when its build log is opened.
 */
import { CvBuildNarrative } from "./CvBuildNarrative";
import { CvBuildProgress } from "./CvBuildProgress";
import type { CvJournalStep } from "@/lib/cv-build-journal";
import {
  CV_MILESTONES,
  currentMotionLine,
  cvBuildMilestone,
  cvBuildProgressLine,
  cvBuildTotals,
  cvBuildTotalsLine,
  narrateBuild,
  type CvMilestone,
  type CvMotionMedians,
  type NarrativeContext,
} from "@/lib/cv-build-narrative";
import type { CvProgressBuild, CvProgressReading } from "@/lib/cv-progress-types";
import type { ReactNode } from "react";

export interface CvBuildViewProps {
  steps: CvJournalStep[];
  /** The page's clock: the server's moment, kept current by `CvBuildLive`. */
  now: number;
  context: NarrativeContext;
  medians: CvMotionMedians;
}

/** A build as it happens: the milestone, what is moving now, and every motion so far. */
export function CvBuildScreen({
  steps,
  now,
  context,
  medians,
  reading,
  build,
  action,
}: CvBuildViewProps & { reading: CvProgressReading; build: CvProgressBuild; action?: ReactNode }) {
  const at = new Date(now);
  const fallback = (CV_MILESTONES as readonly string[]).includes(reading.stage ?? "") ? (reading.stage as CvMilestone) : null;
  return (
    <CvBuildProgress
      milestone={cvBuildMilestone(steps) ?? fallback}
      queued={reading.status === "queued"}
      build={build}
      startedAt={reading.createdAt}
      now={now}
      current={currentMotionLine(steps, at, context, medians)}
      progress={cvBuildProgressLine(steps, at, medians)}
      narrative={<CvBuildNarrative items={narrateBuild(steps, at, context)} />}
      action={build.phase === "stopped" ? action : undefined}
    />
  );
}

/** Above a published CV's log while the improvement pass is still at work: what it is doing. */
export function CvBuildCurrentLine({ steps, now, context, medians }: CvBuildViewProps) {
  const current = currentMotionLine(steps, new Date(now), context, medians);
  if (!current) return null;
  return (
    <p className="text-14" aria-live="polite">
      Still working on this CV after it was saved: {current}
    </p>
  );
}

/** What the build log shows once opened: the run's totals, then its motions in order. */
export function CvBuildLogBody({ steps, now, context, live }: Omit<CvBuildViewProps, "medians"> & { live: boolean }) {
  const at = new Date(now);
  return (
    <>
      <p className="text-14 text-muted">{cvBuildTotalsLine(cvBuildTotals(steps, at, { live }))}</p>
      <CvBuildNarrative items={narrateBuild(steps, at, context)} />
    </>
  );
}
