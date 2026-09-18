"use client";

import { Fragment, startTransition, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { decide, archiveRoles } from "@/app/actions/decisions";
import { Badge, decisionTone } from "@/components/Badge";
import { FitBar, Table, TBody, TD, TH, THead, TR } from "@/components/table";
import { Button, buttonClass } from "@/components/Button";
import type { RoleRowVM } from "@/lib/queries/jobs";

import { ROLE_STATUS_LABELS } from "@christopher/core/role-workflow";

type ReasonKind = "apply" | "skip";

interface ReasonBoxState {
  jobId: string;
  kind: ReasonKind;
  text: string;
  pending: boolean;
  error: string | null;
}

export function RolesTable({ rows: inputRows, hideCompany = false, keyboard = false, archived = false, emptyState }: { hideCompany?: boolean; archived?: boolean; rows: RoleRowVM[]; keyboard?: boolean; emptyState: React.ReactNode }) {
  const router = useRouter();
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const rows = inputRows.filter(row => !removedIds.has(row.id));
  const actionsInFlight = useRef(new Set<string>());
  const [archivingId, setArchivingId] = useState<string | null>(null);
  function archiveRow(id: string) {
    if (actionsInFlight.current.has(id)) return;
    actionsInFlight.current.add(id);
    startTransition(async () => {
    setArchivingId(id); setFlashError(null);
    try {
      const result = await archiveRoles([id], !archived);
      if (!result.ok) setFlashError(result.error);
      else setRemovedIds(ids => new Set([...ids, id]));
      router.refresh();
    } catch { setFlashError("Could not save. Reload to check the current state before retrying."); }
    finally { actionsInFlight.current.delete(id); setArchivingId(null); }
    });
  }
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reasonBox, setReasonBox] = useState<ReasonBoxState | null>(null);
  const [flashError, setFlashError] = useState<string | null>(null);
  const reasonBoxRef = useRef(reasonBox);
  reasonBoxRef.current = reasonBox;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  function openReasonBox(jobId: string, kind: ReasonKind, prefill = "") {
    setExpandedId(jobId);
    setReasonBox({ jobId, kind, text: prefill, pending: false, error: null });
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function submitDecision(jobId: string, decision: ReasonKind | null, reason: string) {
    if (actionsInFlight.current.has(jobId)) return;
    actionsInFlight.current.add(jobId);
    startTransition(async () => {
    setFlashError(null);
    const isBoxed = reasonBoxRef.current?.jobId === jobId;
    if (isBoxed) setReasonBox((b) => (b ? { ...b, pending: true, error: null } : b));
    try {
    const result = await decide(jobId, decision, reason);
    if (!result.ok) {
      if (isBoxed) setReasonBox((b) => (b ? { ...b, pending: false, error: result.error } : b));
      else setFlashError(result.error);
      return;
    }
    if (isBoxed) setReasonBox(null);
    const previous = inputRows.find(row => row.id === jobId);
    if (archived || previous?.decision?.decision !== decision) setRemovedIds(ids => new Set([...ids, jobId]));
    router.refresh();
    } catch {
      const error = "Could not save. Reload to check the current state before retrying.";
      if (isBoxed) setReasonBox(b => b?.jobId === jobId ? { ...b, pending: false, error } : b);
      else setFlashError(error);
    } finally { actionsInFlight.current.delete(jobId); }
    });
  }

  // Keyboard nav: only for the primary table (the daily-inbox view). Ignored while typing.
  useEffect(() => {
    if (!keyboard) return;
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isEditable = !!target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "BUTTON" || target.tagName === "A" || target.isContentEditable);

      if (reasonBoxRef.current?.pending) return;
      if (e.key === "Escape") {
        if (reasonBoxRef.current) {
          setReasonBox(null);
          target?.blur?.();
        }
        return;
      }
      if (isEditable || e.metaKey || e.ctrlKey || e.altKey) return;

      const row = highlightIndex >= 0 ? rows[highlightIndex] : undefined;
      switch (e.key) {
        case "j":
          e.preventDefault();
          setHighlightIndex((i) => Math.min(rows.length - 1, i + 1));
          break;
        case "k":
          e.preventDefault();
          setHighlightIndex((i) => Math.max(0, i - 1));
          break;
        case "o":
          if (row) window.open(row.url, "_blank", "noopener,noreferrer");
          break;
        case "a":
          if (row) void submitDecision(row.id, "apply", "");
          break;
        case "s":
          if (row) openReasonBox(row.id, "skip", row.decision?.decision === "skip" ? row.decision.reason : "");
          break;
        default:
          break;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyboard, rows, highlightIndex]);

  useEffect(() => {
    if (highlightIndex < 0) return;
    const row = rows[highlightIndex];
    if (!row) return;
    document.getElementById(`role-row-${row.id}`)?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex, rows]);

  if (rows.length === 0) return <>{emptyState}</>;

  return (
    <div>
      {keyboard && <details className="mb-3 text-12 text-muted"><summary className="cursor-pointer">Keyboard shortcuts</summary><p> <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>a</kbd> shortlist · <kbd>s</kbd> dismiss · <kbd>o</kbd> open</p></details>}
      {flashError && (
        <p className="mb-2 border-2 border-danger px-3 py-1.5 text-14 text-danger">{flashError}</p>
      )}
      <Table>
        <THead>
          <tr>
            {!hideCompany && <TH>Company</TH>}
            <TH>Role</TH>
            <TH>Location</TH>
            <TH>Fit</TH>
            <TH><span className="sr-only">Action</span></TH>
          </tr>
        </THead>
        <TBody>
          {rows.map((row, index) => {
            const boxed = reasonBox?.jobId === row.id ? reasonBox : null;
            return (
              <Fragment key={row.id}>
                <TR highlighted={index === highlightIndex}>
                  {!hideCompany && <TD>
                    <a href={`/companies/${row.companyId}`} className="flex items-center gap-1.5 no-underline hover:underline">
                      {row.companyFaviconUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={row.companyFaviconUrl}
                          alt=""
                          width={14}
                          height={14}
                          referrerPolicy="no-referrer"
                          className="shrink-0"
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                        />
                      ) : (
                        <span className="inline-block h-3.5 w-3.5 shrink-0 bg-track" />
                      )}
                      <span className="max-w-[12rem] truncate">{row.companyName}</span>
                    </a>
                  </TD>}
                  <TD id={`role-row-${row.id}`} className="max-w-[22rem]">
                    <button type="button" disabled={reasonBox?.pending} onClick={() => { setExpandedId(expandedId === row.id ? null : row.id); setReasonBox(null); }} aria-expanded={expandedId === row.id} className="text-left font-semibold text-fg hover:underline">
                      {row.title}
                    </button>
                    <p className="mt-1 text-12 text-muted"><span title={row.liveForTitle}>{row.liveForText}</span>{row.status === "closed" && <span className="ml-2 text-warn">Vacancy closed</span>}</p>
                  </TD>
                  <TD className="max-w-[10rem]">
                    <div className="flex flex-wrap items-center gap-1">
                      <span>{row.locations.length ? row.locations.join(", ") : row.location}</span>
                      {row.remote && <Badge tone="blue">Remote</Badge>}
                      {!row.location && row.locations.length === 0 && !row.remote && <span className="text-muted">—</span>}
                    </div>
                  </TD>
                  <TD className="whitespace-nowrap">
                    <FitBar score={row.fitScore} />
                  </TD>
                  <TD className="text-right">
                    {row.workflowStatus === "user-shortlisted" ? <a href={`/cv?job=${row.id}`} className={buttonClass("secondary", "sm", "whitespace-nowrap no-underline")}>Build CV</a>
                    : archived ? <Button size="sm" disabled={archivingId !== null || reasonBox?.pending} onClick={() => void archiveRow(row.id)}>{archivingId === row.id ? "Restoring…" : "Restore"}</Button>
                    : <Button
                      size="sm"
                      aria-expanded={expandedId === row.id}
                      aria-controls={`role-review-${row.id}`}
                      aria-label={`${expandedId === row.id ? "Close review for" : "Review"} ${row.title} at ${row.companyName}`}
                      disabled={reasonBox?.pending}
                      onClick={() => { setExpandedId(expandedId === row.id ? null : row.id); setReasonBox(null); }}
                    >
                      {expandedId === row.id ? "Close" : row.workflowStatus === "user-dismissed" ? "Reconsider" : "Review"}
                    </Button>}
                  </TD>
                </TR>
                {expandedId === row.id && (
                  <tr id={`role-review-${row.id}`} className="bg-sunken">
                    <td colSpan={hideCompany ? 4 : 5} className="p-4">
                      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(256px,352px)]">
                        <div className="space-y-3">
                          <p className="text-14 font-semibold text-fg">{row.title}</p>
                          <p className="text-12 text-muted">{[row.department, row.employmentType, row.salaryText].filter(Boolean).join(" · ")}</p>
                          {row.fitRationale && <div><h3 className="ds-label mb-1">Why this fits</h3><p className="max-w-3xl text-14 text-fg">{row.fitRationale}</p></div>}
                          {row.events.filter(event => event.label.includes("archiv")).map(event => <p key={event.id} className="text-12 text-muted">{event.label}</p>)}
                          <div className="flex flex-wrap items-center gap-4 text-12">
                            <a href={`/cv?job=${row.id}`} className="font-semibold underline">Build CV</a>
                            <a href={row.url} target="_blank" rel="noopener noreferrer" className="text-muted underline">View vacancy ↗</a>
                            <a href={row.companyHomepageUrl} target="_blank" rel="noopener noreferrer" className="text-muted underline">Company website ↗</a>
                          </div>
                        </div>
                        <div className="space-y-3">
                          <h3 className="ds-label">{ROLE_STATUS_LABELS[row.workflowStatus]}</h3>
                    {boxed ? (
                      <div className="flex flex-col gap-2">
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant={boxed.kind === "apply" ? "primary" : "secondary"}
                            aria-pressed={boxed.kind === "apply"}
                            disabled={boxed.pending} onClick={() => setReasonBox({ ...boxed, kind: "apply" })}
                          >
                            Shortlist
                          </Button>
                          <Button
                            size="sm"
                            variant={boxed.kind === "skip" ? "primary" : "secondary"}
                            aria-pressed={boxed.kind === "skip"}
                            disabled={boxed.pending} onClick={() => setReasonBox({ ...boxed, kind: "skip" })}
                          >
                            Dismiss
                          </Button>
                        </div>
                        {boxed.kind === "skip" && <div className="flex flex-wrap gap-2">
                          {["Wrong location", "Wrong seniority", "Not interested"].map(reason => <Button key={reason} size="sm" variant="ghost" disabled={boxed.pending}
                            onClick={() => setReasonBox({ ...boxed, text: reason })}>{reason}</Button>)}
                        </div>}
                        <textarea disabled={boxed.pending}
                          ref={textareaRef}
                          value={boxed.text}
                          onChange={(e) => setReasonBox({ ...boxed, text: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") {
                              e.stopPropagation();
                              setReasonBox(null);
                              e.currentTarget.blur();
                            } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                              e.preventDefault();
                              if (!boxed.pending) void submitDecision(row.id, boxed.kind, boxed.text);
                            }
                          }}
                          placeholder={boxed.kind === "skip" ? "Why is this not for you? (required)" : "Add a reason (optional, but it improves the ranking)"}
                          rows={2}
                          className="w-full resize-y border-2 border-line-muted bg-bg px-2 py-1 font-mono text-12 text-fg placeholder:text-faint focus:border-line focus:outline-none"
                        />
                        {boxed.error && <p className="text-12 text-danger">{boxed.error}</p>}
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={boxed.pending}
                            onClick={() => void submitDecision(row.id, boxed.kind, boxed.text)}
                          >
                            {boxed.pending ? "Saving…" : "Save"}
                          </Button>
                          <Button size="sm" variant="ghost" disabled={boxed.pending} onClick={() => setReasonBox(null)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : row.decision ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={decisionTone(row.decision.decision)}>{row.decision.decision === "apply" ? "User-shortlisted" : "User-dismissed"}</Badge>
                        {row.decision.reason && <p className="w-full text-14 text-fg">{row.decision.reason}</p>}
                        <button type="button" onClick={() => openReasonBox(row.id, row.decision!.decision, row.decision!.reason)} className="text-12 text-muted underline hover:text-fg">
                          Reconsider
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            void submitDecision(row.id, null, "");
                          }}
                          className="text-12 text-muted underline hover:text-fg"
                        >
                          Reset my decision
                        </button>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <Button size="sm" variant="primary" onClick={() => void submitDecision(row.id, "apply", "")}>
                          Shortlist
                        </Button>
                        <Button size="sm" onClick={() => openReasonBox(row.id, "skip")}>
                          Dismiss
                        </Button>
                      </div>
                    )}
                    <button type="button" disabled={archivingId !== null || reasonBox?.pending} onClick={() => void archiveRow(row.id)} className="mt-2 text-12 text-muted underline disabled:opacity-40">{archivingId === row.id ? "Saving…" : archived ? "Restore" : "Archive"}</button>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </TBody>
      </Table>
    </div>
  );
}
