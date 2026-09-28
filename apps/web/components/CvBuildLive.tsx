"use client";

import { useEffect, useRef, useState, useTransition, type ComponentProps, type ComponentType, type ReactNode } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CvDisclosure } from "./CvDisclosure";
import { useVisiblePoll } from "./useVisiblePoll";
import type * as Views from "./CvBuildViews";
import { adoptedRevision } from "@/lib/cv-build-adopted";
import { cvStepsSignature as signature, mergeSteps, stepFromWire, type CvJournalStep } from "@/lib/cv-build-journal";
import type { CvMotionMedians, NarrativeContext } from "@/lib/cv-build-narrative";
import { FIRST_POLL_MS, failedWorkPoll, initialWorkPoll, nextLogPoll, stepProgressPoll } from "@/lib/polling";
import type { CvProgressBuild, CvProgressReading } from "@/lib/cv-progress-types";

/**
 * A view whose chunk could not be fetched (offline, or a deployment that replaced it) says so in
 * its place. Without this the rejected import would reach the route's error boundary and take the
 * whole CV page, editor and all, down with the log.
 */
function unavailable<P>(sentence: string): ComponentType<P> {
  return function Unavailable() {
    return <p className="text-14 text-muted">{sentence}</p>;
  };
}

// The narrative's views, split from this module (see CvBuildViews). No `loading` option, as in
// CvLazyWidgets: it would add a Suspense boundary that flashes a fallback during a refresh.
const CvBuildScreen = dynamic(() =>
  import("./CvBuildViews").then(
    (module) => module.CvBuildScreen,
    () => unavailable<ComponentProps<typeof Views.CvBuildScreen>>("This build's progress could not be loaded. Check your connection and reload the page."),
  ),
);
const CvBuildCurrentLine = dynamic(() =>
  import("./CvBuildViews").then(
    (module) => module.CvBuildCurrentLine,
    () => unavailable<ComponentProps<typeof Views.CvBuildCurrentLine>>("Still working on this CV after it was saved."),
  ),
);
const CvBuildLogBody = dynamic(() =>
  import("./CvBuildViews").then(
    (module) => module.CvBuildLogBody,
    () => unavailable<ComponentProps<typeof Views.CvBuildLogBody>>("The build log could not be loaded. Check your connection and reload the page."),
  ),
);

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
 * itself, through the views in CvBuildViews (a chunk of their own: a finished CV fetches it only
 * when its log is opened). The page is rendered again on the server only when the feed's version changes (the
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
  // The browser's clock can be minutes out; every moment on this page is the server's. Taken once,
  // at mount, as the difference between the server's clock when it rendered and the browser's now,
  // and applied to every elapsed figure, so a skewed clock neither freezes a running motion at zero
  // nor starts it minutes in.
  const [skew] = useState(() => nowMs - Date.now());
  const skewRef = useRef(skew);
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  const live = mode === "build" ? reading.active || reading.live : reading.live;

  // One clock for every elapsed figure on the narrative, running only while something can move and
  // someone can see it. A hidden tab re-renders nothing; the figures catch up the moment it is
  // looked at again, since each is worked out from the moment rather than counted up.
  useEffect(() => {
    if (!live) return;
    const tick = () => {
      if (document.visibilityState === "visible") setNow(Date.now() + skewRef.current);
    };
    tick();
    const timer = setInterval(tick, 1_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [live]);

  useVisiblePoll(() => {
    if (!initial.live && !(mode === "build" && initial.active)) return null;
    let state = initialWorkPoll(initial.version);
    let logWait = FIRST_POLL_MS;
    let resynced = false;
    return {
      first: FIRST_POLL_MS,
      async read(signal, alive, resync) {
        const held = stepsRef.current;
        const sig = signature(held);
        const after = resync ? 0 : held.reduce((max, step) => Math.max(max, step.seq), 0);
        const response = await fetch(`/api/cv/${id}/progress?after=${after}&sig=${encodeURIComponent(sig)}&tz=${encodeURIComponent(timeZone)}`, {
          cache: "no-store",
          signal,
        });
        if (response.status === 404 || response.status === 401) {
          // The draft is gone (deleted, or never this account's) or the session has ended: no later
          // reading can answer. The server renders what is true now — the not-found page, or the
          // sign-in — and this stops asking rather than backing off for ever over a silent page.
          startTransition(() => router.refresh());
          return null;
        }
        if (!response.ok) throw new Error("Progress unavailable");
        const next_ = (await response.json()) as CvProgressReading;
        if (!alive()) return null;
        const merged = mergeSteps(held, next_.steps.map(stepFromWire), resync);
        const mine = signature(merged);
        const changed = mine !== sig;
        stepsRef.current = merged;
        setSteps(merged);
        setReading(next_);
        if (next_.build) setBuild(next_.build);
        setNow(Date.now() + skewRef.current);
        let next: number | null;
        if (mode === "build") {
          const step = stepProgressPoll(state, { active: next_.active, version: next_.version }, changed);
          state = step.state;
          next = step.next;
          if (step.reload) {
            // The build screen holds no edits to lose, so a stuck soft refresh is recovered whole.
            window.location.reload();
            return null;
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
          return "resync";
        }
        if (mine === next_.signature) resynced = false;
        return next;
      },
      fail() {
        if (mode === "build") {
          const failed = failedWorkPoll(state);
          state = failed.state;
          return failed.next;
        }
        logWait = Math.min(logWait * 2, 60_000);
        return logWait;
      },
    };
    // A landed refresh renders this with a new version, which starts the poller afresh.
  }, [id, mode, timeZone, router, initial.version, initial.live, initial.active]);

  const interrupted = mode === "build" ? build?.phase === "stopped" : !reading.live;
  const context: NarrativeContext = {
    timeZone,
    versionLabel,
    interrupted,
    stoppedAt: build?.lastProgressAt ? new Date(build.lastProgressAt) : lastMoment(steps),
    maxAttemptsFallback: maxAttempts,
  };
  if (mode === "build") {
    if (!build) return null;
    return <CvBuildScreen steps={steps} now={now} context={context} medians={medians} reading={reading} build={build} action={action} />;
  }

  if (!steps.length) return null;
  const adopted = adoptedRevision(steps);
  return (
    <section className="space-y-3 border-2 border-line bg-raised p-4">
      {reading.live && <CvBuildCurrentLine steps={steps} now={now} context={context} medians={medians} />}
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
      {/* Told only while open: closed, the log is not re-narrated on every tick of the clock, and
          on a finished CV its chunk is not even fetched until someone asks to read it. */}
      <CvDisclosure label="build log" mountWhenOpen>
        <CvBuildLogBody steps={steps} now={now} context={context} live={reading.live} />
      </CvDisclosure>
    </section>
  );
}
