"use client";
/**
 * Pause, Archive and Stop following used to sit side by side as three buttons that differed only
 * in their confirm text, on two pages. They are one control: a collapsed menu that says in plain
 * words what each does and what it leaves behind, with the confirm texts unchanged.
 *
 * A client component that calls the actions itself. It used to be a server component rendering one
 * `<form action={action.bind(null, companyId)}>` per button, so every row of the companies table
 * serialised three or four bound action references, their bound arguments and the buttons' markup
 * into the page, open or not. Now a row sends its few props, the action references are sent once
 * per page, and the buttons are rendered only when the menu is opened.
 *
 * The subscription is this account's; the shared company, its sources and every observed posting
 * are untouched by all three. Each action authenticates and scopes by the caller's own
 * subscription, so the company id the client sends is no more than a name for the row.
 */
import { useState, useTransition } from "react";
import { archiveCompany, pauseCompany, rediscoverCompany, refreshCompany, resumeCompany, unfollowCompany } from "@/app/actions/companies";
import { Button } from "@/components/Button";
import type { CompanySubscription } from "@ava/db/schema";

type MenuAction = "refresh" | "rediscover" | "pause" | "resume" | "archive" | "unfollow";

const ACTIONS: Record<MenuAction, (companyId: string) => Promise<void>> = {
  refresh: refreshCompany,
  rediscover: rediscoverCompany,
  pause: pauseCompany,
  resume: resumeCompany,
  archive: archiveCompany,
  unfollow: unfollowCompany,
};

export function CompanyManageMenu({
  companyId,
  companyName,
  status,
  extra,
  running = false,
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
  /**
   * The sentence an unverified account gets instead of a refusal at press time: the actions still
   * ask `requireVerifiedUser()` for themselves, this only stops the press.
   */
  blockedReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<MenuAction | null>(null);
  const [, startTransition] = useTransition();

  function run(action: MenuAction, confirmMessage?: string) {
    if (pending) return;
    if (confirmMessage && !confirm(confirmMessage)) return;
    setPending(action);
    // The action revalidates the company pages, so its own response carries the fresh page; a
    // refusal comes back as the redirect it has always been.
    startTransition(async () => {
      try {
        await ACTIONS[action](companyId);
      } finally {
        setPending(null);
      }
    });
  }

  return (
    <details className="border-2 border-line-muted bg-raised" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="ds-pixel cursor-pointer px-2.5 py-1 text-10 text-fg">Manage</summary>
      {open && (
        <div className="space-y-2 border-t-2 border-line-muted p-2">
          <div className="flex flex-wrap gap-2">
            {extra === "refresh" && status === "active" && (
              <Button size="sm" disabled={pending !== null || running || !!blockedReason} title={blockedReason} onClick={() => run("refresh")}>
                {pending === "refresh" || running ? "Refreshing…" : "Refresh"}
              </Button>
            )}
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
          <p className="text-12 text-muted">
            Pause stops the daily scan; Hide takes it off your list and keeps everything; Stop following removes its roles from your table.
          </p>
        </div>
      )}
    </details>
  );
}
