"use client";
/** Follow controls live on the company page; list rows link to this named task. */
import { useState } from "react";
import Link from "next/link";
import { archiveCompany, pauseCompany, rediscoverCompany, refreshCompany, resumeCompany, unfollowCompany } from "@/app/actions/companies";
import { Button } from "@/components/Button";
import { useActionCall } from "@/components/useActionCall";
import type { CompanySubscription } from "@col/db/schema";

type MenuAction = "refresh" | "rediscover" | "pause" | "resume" | "archive" | "unfollow";

const ACTIONS: Record<Exclude<MenuAction, "resume">, (companyId: string) => Promise<void>> = {
  refresh: refreshCompany,
  rediscover: rediscoverCompany,
  pause: pauseCompany,
  archive: archiveCompany,
  unfollow: unfollowCompany,
};

export function CompanyManageMenu({
  companyId,
  companyName,
  status,
  extra,
  running = false,
  monitoringIssue,
  blockedReason,
}: {
  companyId: string;
  companyName: string;
  status: CompanySubscription["status"];
  /**
   * The occasional control that lives in the menu rather than beside it: Refresh on the companies
   * table (only for an active follow), Re-discover on the company page.
   */
  extra?: "refresh" | "rediscover";
  /** A discovery already running for this company, which Refresh would only repeat. */
  running?: boolean;
  /** A leased task remains owned, but the worker may not be able to finish it yet. */
  monitoringIssue?: "stopped" | "restarting";
  /**
   * The sentence an unverified account gets instead of a refusal at press time: the actions still
   * ask `requireVerifiedUser()` for themselves, this only stops the press.
   */
  blockedReason?: string;
}) {
  const [recovery, setRecovery] = useState<{ href: string; label: string } | null>(null);
  const call = useActionCall<MenuAction>();
  const pending = call.pending;

  function run(action: MenuAction, confirmMessage?: string) {
    call.run(action, async () => {
      setRecovery(null);
      if (action === "resume") {
        const result = await resumeCompany(companyId);
        if (!result.ok) { call.setError(result.error); setRecovery(result.recovery ?? null); }
      } else await ACTIONS[action](companyId);
    }, { confirm: confirmMessage });
  }

  if (extra === "refresh") return <Link prefetch={false} href={`/companies/${companyId}#manage`} className="inline-flex min-h-11 items-center text-13 underline">Manage</Link>;
  return (
    <section id="manage" aria-label="Manage company" className="scroll-mt-4 border border-line-muted bg-raised">
        <div className="space-y-2 border-t-2 border-line-muted p-2">
          <div className="flex flex-wrap gap-2">
            {extra === "rediscover" && (
              <Button size="sm" disabled={pending !== null || !!blockedReason} title={blockedReason} onClick={() => run("rediscover")}>Re-discover</Button>
            )}
            {status === "active" ? (
              <Button size="sm" disabled={pending !== null} onClick={() => run("pause")}>Pause scanning</Button>
            ) : (
              <Button size="sm" disabled={pending !== null} onClick={() => run("resume")}>{status === "paused" ? "Resume scanning" : "Follow again"}</Button>
            )}
            {status !== "archived" && (
              <Button variant="ghost" size="sm" disabled={pending !== null}
                onClick={() => run("archive", `Archive ${companyName}? It leaves your inbox; other followers are unaffected.`)}>
                Hide from my list
              </Button>
            )}
            <Button variant="ghost" size="sm" disabled={pending !== null}
              onClick={() => run("unfollow", `Stop following ${companyName}? Its roles leave your table. Your decision snapshots are retained.`)}>
              Stop following
            </Button>
          </div>
          {call.error && <p role="alert" className="text-12 text-danger">{call.error}</p>}
          {recovery && <a href={recovery.href} className="inline-flex min-h-11 items-center text-12 underline">{recovery.label}</a>}
        </div>
    </section>
  );
}
