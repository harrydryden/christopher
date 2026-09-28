"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { failedWorkPoll, initialWorkPoll, stepWorkPoll, type WorkReading } from "@/lib/polling";
import { useVisiblePoll } from "./useVisiblePoll";

/**
 * Refresh the page while work it shows is in flight, and once more when that work finishes.
 *
 * `scope` names which of the account's work the page watches (its companies', the same work as the
 * Roles page sees it, or its CVs'), and
 * `initialVersion` is that work's version as the page rendered it; a page that passes both is
 * compared with exactly what it shows. The rules live in lib/polling.ts: a refresh per changed
 * version, asked for again a few times while a page that rendered its version has not shown the
 * new one (a landed refresh renders this component with the new `initialVersion`, which starts the
 * poller afresh), a wait that grows from ten seconds to a minute while nothing changes, nothing
 * asked of a hidden tab, and no more asking once the work is finished.
 */
export function AutoRefresh({
  cvId,
  scope,
  initialVersion,
  message = "Waiting for the worker to generate your CV. Status updates automatically.",
}: {
  cvId?: string;
  scope?: "company" | "roles" | "cv";
  initialVersion?: string;
  message?: string | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  useVisiblePoll(() => {
    let state = initialWorkPoll(initialVersion);
    const url = cvId ? `/api/work-status?cv=${cvId}` : `/api/work-status${scope ? `?scope=${scope}` : ""}`;
    return {
      // A page that says what it rendered is current now; one that does not is read at once, for
      // the version its later readings are compared with.
      first: initialVersion === undefined ? "now" : state.wait,
      async read(signal, alive) {
        const response = await fetch(url, { cache: "no-store", signal });
        if (!response.ok) throw new Error("Status unavailable");
        const reading = (await response.json()) as WorkReading;
        if (!alive()) return null;
        const step = stepWorkPoll(state, reading);
        state = step.state;
        if (step.reload) {
          // Only an individual CV's build screen has no edits to lose. Other pages can hold
          // unsaved form input, so give them the original final soft-refresh attempt.
          if (cvId) window.location.reload();
          else startTransition(() => router.refresh());
          return null;
        }
        if (step.refresh) startTransition(() => router.refresh());
        return step.next;
      },
      // A refused or dropped poll is not news: ask again, and back off only when they keep failing.
      fail() {
        const failed = failedWorkPoll(state);
        state = failed.state;
        return failed.next;
      },
    };
  }, [router, cvId, scope, initialVersion]);
  return message === null ? null : (
    <p role="status" className="text-14">
      {message}
    </p>
  );
}
