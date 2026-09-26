"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CvBuildNarrative } from "./CvBuildNarrative";
import { CvBuildProgress } from "./CvBuildProgress";
import { CvDisclosure } from "./CvDisclosure";
import { cvStepsSignature as signature, mergeSteps, stepFromWire, type CvJournalStep } from "@/lib/cv-build-journal";
import {
  CV_MILESTONES,
  adoptedRevision,
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
import { FIRST_POLL_MS, failedWorkPoll, initialWorkPoll, nextLogPoll, stepProgressPoll } from "@/lib/polling";
import type { CvProgressBuild, CvProgressReading } from "@/lib/cv-progress-types";

function lastMoment(steps: readonly CvJournalStep[]): Date | null {
  let last = 0;
  for (const step of steps) last = Math.max(last, (step.finishedAt ?? step.startedAt).getTime());
  return last ? new Date(last) : null;
}

/**
 * A CV build as it happens, or its log once it is over, kept current by the progress feed.
 *
 * The page renders this once with everything it read; from then on it asks
 * `/api/cv/[id]/progress` for only what moved — one query per reading — and renders the narrative
 * itself. The page is rendered again on the server only when the feed's version changes (the
 * draft's status, a failure, the build going stale or stopping), and a finished build keeps the
 * settle-then-reload rule of `stepWorkPoll`: two soft refreshes, then a document reload if neither
 * landed, so a lost refresh cannot leave the page on a build that has finished.
 *
 * As a log (`mode="log"`), on a ready page, it keeps reading while the improvement pass that runs
 * after the CV was published is still writing to the ledger, and points at the revision it adopted.
 */
export function CvBuildLive({
  id,
  mode,
  initial,
  nowMs,
  timeZone,
  versionLabel,
  maxAttempts = null,
  medians = {},
  action,
}: {
  id: string;
  mode: "build" | "log";
  initial: CvProgressReading;
  /** The server's clock when it rendered, so the first client render matches it. */
  nowMs: number;
  timeZone: string;
  versionLabel: string;
  maxAttempts?: number | null;
  medians?: CvMotionMedians;
  /** The way out of a stopped build, rendered by the server. */
  action?: ReactNode;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [steps, setSteps] = useState<CvJournalStep[]>(() => initial.steps.map(stepFromWire));
  const [reading, setReading] = useState(initial);
  const [build, setBuild] = useState<CvProgressBuild | null>(initial.build);
  const [now, setNow] = useState(nowMs);
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  const live = mode === "build" ? reading.active || reading.live : reading.live;

  // One clock for every elapsed figure on the narrative, running only while something can move.
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [live]);

  useEffect(() => {
    if (!initial.live && !(mode === "build" && initial.active)) return;
    let cancelled = false;
    let state = initialWorkPoll(initial.version);
    let logWait = FIRST_POLL_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let parked = false;
    let resynced = false;
    async function poll(resync = false) {
      timer = undefined;
      if (cancelled) return;
      if (document.visibilityState !== "visible") {
        parked = true;
        return;
      }
      const held = stepsRef.current;
      const sig = signature(held);
      const after = resync ? 0 : held.reduce((max, step) => Math.max(max, step.seq), 0);
      let next: number | null;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 8000);
      try {
        const response = await fetch(`/api/cv/${id}/progress?after=${after}&sig=${encodeURIComponent(sig)}&tz=${encodeURIComponent(timeZone)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 404 || response.status === 401) {
          // The draft is gone (deleted, or never this account's) or the session has ended: no later
          // reading can answer. The server renders what is true now — the not-found page, or the
          // sign-in — and this stops asking rather than backing off for ever over a silent page.
          startTransition(() => router.refresh());
          return;
        }
        if (!response.ok) throw new Error("Progress unavailable");
        const next_ = (await response.json()) as CvProgressReading;
        if (cancelled) return;
        const merged = mergeSteps(held, next_.steps.map(stepFromWire), resync);
        const mine = signature(merged);
        const changed = mine !== sig;
        stepsRef.current = merged;
        setSteps(merged);
        setReading(next_);
        if (next_.build) setBuild(next_.build);
        setNow(Date.now());
        if (mode === "build") {
          const step = stepProgressPoll(state, { active: next_.active, version: next_.version }, changed);
          state = step.state;
          next = step.next;
          if (step.reload) {
            // The build screen holds no edits to lose, so a stuck soft refresh is recovered whole.
            window.location.reload();
            return;
          }
          if (step.refresh) startTransition(() => router.refresh());
        } else {
          next = nextLogPoll(logWait, next_.live, changed);
          if (next === null) {
            // The pass after publication has finished: render its outcome on the server once.
            startTransition(() => router.refresh());
          } else logWait = next;
        }
        // Rows in hand that the ledger does not agree with — a close that committed after a later
        // one was read — are read again whole, once, rather than trusted.
        if (next !== null && mine !== next_.signature && !resynced) {
          resynced = true;
          timer = setTimeout(() => void poll(true), 0);
          return;
        }
        if (mine === next_.signature) resynced = false;
      } catch {
        if (mode === "build") {
          const failed = failedWorkPoll(state);
          state = failed.state;
          next = failed.next;
        } else {
          logWait = Math.min(logWait * 2, 60_000);
          next = logWait;
        }
      } finally {
        clearTimeout(timeout);
      }
      if (!cancelled && next !== null) timer = setTimeout(() => void poll(), next);
    }
    function onVisibility() {
      if (parked && document.visibilityState === "visible") {
        parked = false;
        void poll();
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    timer = setTimeout(() => void poll(), FIRST_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // A landed refresh renders this with a new version, which starts the poller afresh.
  }, [id, mode, timeZone, router, initial.version, initial.live, initial.active]);

  const at = useMemo(() => new Date(now), [now]);
  const interrupted = mode === "build" ? build?.phase === "stopped" : !reading.live;
  const context: NarrativeContext = {
    timeZone,
    versionLabel,
    interrupted,
    stoppedAt: build?.lastProgressAt ? new Date(build.lastProgressAt) : lastMoment(steps),
    maxAttemptsFallback: maxAttempts,
  };
  const items = narrateBuild(steps, at, context);

  if (mode === "build") {
    if (!build) return null;
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
        narrative={<CvBuildNarrative items={items} />}
        action={build.phase === "stopped" ? action : undefined}
      />
    );
  }

  if (!steps.length) return null;
  const adopted = adoptedRevision(steps);
  const current = reading.live ? currentMotionLine(steps, at, context, medians) : null;
  return (
    <section className="space-y-3 border-2 border-line bg-raised p-4">
      {current && (
        <p className="text-14" aria-live="polite">
          Still working on this CV after it was saved: {current}
        </p>
      )}
      {adopted && (
        <p className="text-14" role="status">
          A stronger revision was adopted:{" "}
          {adopted.draftId ? (
            <Link prefetch={false} href={`/cv/${adopted.draftId}`} className="underline">
              open {adopted.name ?? "it"}
            </Link>
          ) : (
            <>open {adopted.name ?? "it"} from Applications</>
          )}
        </p>
      )}
      <CvDisclosure label="build log">
        <p className="text-14 text-muted">{cvBuildTotalsLine(cvBuildTotals(steps, at, { live: reading.live }))}</p>
        <CvBuildNarrative items={items} />
      </CvDisclosure>
    </section>
  );
}
