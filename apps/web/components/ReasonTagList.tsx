"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Decision } from "@col/db/schema";
import { Button, buttonLinkClass } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { ReasonTagEditor } from "@/components/ReasonTagEditor";

export type ReasonTagDecision = Pick<Decision, "id" | "jobTitle" | "companyName" | "decision" | "reason" | "tags" | "tagsEdited">;
type Retained = { decision: ReasonTagDecision; pending: boolean };

/** A draft remains mounted when its decision leaves the current server page. */
export function ReasonTagList({ recent, options, disabled, page = 1, totalPages = 1, totalDecisions = recent.length, profileVersionParam, compareParam }: {
  recent: ReasonTagDecision[];
  options: Array<{ tag: string }>;
  disabled: boolean;
  page?: number;
  totalPages?: number;
  totalDecisions?: number;
  profileVersionParam?: string;
  compareParam?: string;
}) {
  const [retained, setRetained] = useState<Record<string, Retained>>({});
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const recentIds = new Set(recent.map(decision => decision.id));
  const recentIdsRef = useRef(recentIds);
  recentIdsRef.current = recentIds;
  const rows = [...recent, ...Object.values(retained).filter(row => !recentIds.has(row.decision.id)).map(row => row.decision)];
  useEffect(() => { if (savedNotice) noticeRef.current?.focus(); }, [savedNotice]);

  function retentionChanged(decision: ReasonTagDecision, keep: boolean, pending: boolean, saved = false) {
    if (saved && !recentIdsRef.current.has(decision.id)) setSavedNotice(`Tags saved for ${decision.jobTitle} at ${decision.companyName}. This decision is outside the page you are viewing.`);
    setRetained(current => {
      if (!keep) {
        if (!current[decision.id]) return current;
        const next = { ...current };
        delete next[decision.id];
        return next;
      }
      return { ...current, [decision.id]: { decision: current[decision.id]?.decision ?? decision, pending } };
    });
  }

  function discard(id: string) {
    setRetained(current => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }

  function pageHref(target: number) {
    const params = new URLSearchParams();
    if (profileVersionParam) params.set("v", profileVersionParam);
    if (compareParam) params.set("compare", compareParam);
    if (target > 1) params.set("tagsPage", String(target));
    const query = params.toString();
    return query ? `/learning?${query}` : "/learning";
  }

  function pager(position: "top" | "bottom") {
    if (totalPages < 2) return null;
    return <nav aria-label={`Reason tag pages${position === "bottom" ? " (bottom)" : ""}`}
      className="my-3 flex flex-wrap items-center gap-2 text-13">
      {page > 1
        ? <Link href={pageHref(page - 1)} scroll={false} className={buttonLinkClass("secondary", "sm")}>Newer decisions</Link>
        : <span className="text-muted">Newest decisions</span>}
      <span className="text-muted">Page {page} of {totalPages} · {totalDecisions} decisions</span>
      {page < totalPages
        ? <Link href={pageHref(page + 1)} scroll={false} className={buttonLinkClass("secondary", "sm")}>Older decisions</Link>
        : <span className="text-muted">Oldest decisions</span>}
    </nav>;
  }

  return <div>
    {savedNotice && <p ref={noticeRef} role="status" tabIndex={-1} className="mb-3 text-14 text-success">{savedNotice}</p>}
    {pager("top")}
    {rows.length === 0 && (totalDecisions === 0
      ? <EmptyState title="No decisions yet" description="Shortlist or skip a role to start recording your preferences." />
      : <EmptyState title="No decisions on this page" description="Use Newer decisions to return to the latest page." />)}
    {rows.map(decision => {
      const outsideRecent = !recentIds.has(decision.id);
      return <section key={decision.id} className="mb-2 border border-line-muted p-3">
        <h3 className="text-14">{decision.jobTitle} · {decision.companyName} · {decision.decision}</h3>
        <p className="my-2 text-14 text-muted">{decision.reason}</p>
        {outsideRecent && <div className="mb-3 flex flex-wrap items-center gap-2 border-l-2 border-accent pl-3">
          <p className="text-13 text-muted">This decision is outside the page you are viewing. Your tag draft is still here. Saving will check that the decision is still current.</p>
          <Button variant="secondary" size="sm" disabled={retained[decision.id]?.pending}
            aria-label={`Discard tag draft for ${decision.jobTitle} at ${decision.companyName}`}
            onClick={() => discard(decision.id)}>Discard draft</Button>
        </div>}
        <ReasonTagEditor decisionId={decision.id} tags={decision.tags} tagsEdited={decision.tagsEdited}
          options={options} disabled={disabled}
          onRetentionChange={(keep, pending, saved) => retentionChanged(decision, keep, pending, saved)} />
      </section>;
    })}
    {pager("bottom")}
  </div>;
}
