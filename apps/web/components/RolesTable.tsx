"use client";

import { Fragment, startTransition, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { decide, archiveRoles } from "@/app/actions/decisions";
import { Badge, decisionTone } from "@/components/Badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/table";
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

function FitBar({ score }: { score: number | null }) {
  if (score === null) return <span className="text-slate-500">—</span>;
  const tone = score >= 70 ? "bg-emerald-500" : score >= 30 ? "bg-amber-500" : "bg-red-400";
  return (
    <div className="flex items-center gap-2">
      <span className="w-6 text-right tabular-nums text-slate-700">{score}</span>
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-track">
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${Math.max(2, Math.min(100, score))}%` }} />
      </span>
    </div>
  );
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
      {keyboard && <details className="mb-3 text-xs text-slate-500"><summary className="cursor-pointer">Keyboard shortcuts</summary><p> <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>a</kbd> shortlist · <kbd>s</kbd> dismiss · <kbd>o</kbd> open</p></details>}
      {flashError && (
        <p className="mb-2 rounded-md bg-red-50 px-3 py-1.5 text-sm text-red-700">{flashError}</p>
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
                    <a href={`/companies/${row.companyId}`} className="flex items-center gap-1.5 hover:underline">
                      {row.companyFaviconUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={row.companyFaviconUrl}
                          alt=""
                          width={14}
                          height={14}
                          referrerPolicy="no-referrer"
                          className="rounded-sm"
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                        />
                      ) : (
                        <span className="inline-block h-3.5 w-3.5 rounded-sm bg-slate-200" />
                      )}
                      <span className="max-w-[12rem] truncate">{row.companyName}</span>
                    </a>
                  </TD>}
                  <TD id={`role-row-${row.id}`} className="max-w-[22rem]">
                    <button type="button" disabled={reasonBox?.pending} onClick={() => { setExpandedId(expandedId === row.id ? null : row.id); setReasonBox(null); }} aria-expanded={expandedId === row.id} className="text-left font-medium text-slate-900 hover:underline">
                      {row.title}
                    </button>
                    <p className="mt-1 text-xs text-slate-500"><span title={row.liveForTitle}>{row.liveForText}</span>{row.status === "closed" && <span className="ml-2 font-medium text-amber-700">Vacancy closed</span>}</p>
                  </TD>
                  <TD className="max-w-[10rem]">
                    <div className="flex flex-wrap items-center gap-1">
                      <span>{row.locations.length ? row.locations.join(", ") : row.location}</span>
                      {row.remote && <Badge tone="blue">Remote</Badge>}
                      {!row.location && row.locations.length === 0 && !row.remote && <span className="text-slate-500">—</span>}
                    </div>
                  </TD>
                  <TD className="whitespace-nowrap">
                    <FitBar score={row.fitScore} />
                  </TD>
                  <TD className="text-right">
                    {row.workflowStatus === "user-shortlisted" ? <a href={`/cv?job=${row.id}`} className="whitespace-nowrap rounded border border-slate-200 px-3 py-1 text-xs font-medium">Build CV</a>
                    : archived ? <button type="button" disabled={archivingId !== null || reasonBox?.pending} onClick={() => void archiveRow(row.id)} className="rounded border border-slate-200 px-3 py-1 text-xs font-medium disabled:opacity-40">{archivingId === row.id ? "Restoring…" : "Restore"}</button>
                    : <button
                      type="button"
                      aria-expanded={expandedId === row.id}
                      aria-controls={`role-review-${row.id}`}
                      aria-label={`${expandedId === row.id ? "Close review for" : "Review"} ${row.title} at ${row.companyName}`}
                      disabled={reasonBox?.pending}
                      onClick={() => { setExpandedId(expandedId === row.id ? null : row.id); setReasonBox(null); }}
                      className="rounded border border-slate-200 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                    >
                      {expandedId === row.id ? "Close" : row.workflowStatus === "user-dismissed" ? "Reconsider" : "Review"}
                    </button>}
                  </TD>
                </TR>
                {expandedId === row.id && (
                  <tr id={`role-review-${row.id}`} className="bg-slate-50/70">
                    <td colSpan={hideCompany ? 4 : 5} className="px-4 py-4">
                      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)]">
                        <div className="space-y-3">
                          <p className="text-sm font-medium text-slate-900">{row.title}</p>
                          <p className="text-xs text-slate-500">{[row.department, row.employmentType, row.salaryText].filter(Boolean).join(" · ")}</p>
                          {row.fitRationale && <div><h3 className="mb-1 text-xs font-medium text-slate-700">Why this fits</h3><p className="max-w-3xl text-sm text-slate-600">{row.fitRationale}</p></div>}
                          {row.events.filter(event => event.label.includes("archiv")).map(event => <p key={event.id} className="text-xs text-slate-500">{event.label}</p>)}
                          <div className="flex flex-wrap items-center gap-4 text-xs">
                            <a href={`/cv?job=${row.id}`} className="font-medium underline">Build CV</a>
                            <a href={row.url} target="_blank" rel="noopener noreferrer" className="text-slate-500 underline">View vacancy ↗</a>
                            <a href={row.companyHomepageUrl} target="_blank" rel="noopener noreferrer" className="text-slate-500 underline">Company website ↗</a>
                          </div>
                        </div>
                        <div className="space-y-3">
                          <h3 className="text-xs font-medium text-slate-700">{ROLE_STATUS_LABELS[row.workflowStatus]}</h3>
                    {boxed ? (
                      <div className="flex flex-col gap-1.5">
                        <div className="flex gap-1">
                          <button
                            type="button"
                            disabled={boxed.pending} onClick={() => setReasonBox({ ...boxed, kind: "apply" })}
                            className={`rounded px-1.5 py-0.5 text-xs font-medium ${boxed.kind === "apply" ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-600"}`}
                          >
                            Shortlist
                          </button>
                          <button
                            type="button"
                            disabled={boxed.pending} onClick={() => setReasonBox({ ...boxed, kind: "skip" })}
                            className={`rounded px-1.5 py-0.5 text-xs font-medium ${boxed.kind === "skip" ? "bg-red-600 text-white" : "bg-slate-100 text-slate-600"}`}
                          >
                            Dismiss
                          </button>
                        </div>
                        {boxed.kind === "skip" && <div className="flex flex-wrap gap-1">
                          {["Wrong location", "Wrong seniority", "Not interested"].map(reason => <button key={reason} type="button" disabled={boxed.pending}
                            onClick={() => setReasonBox({ ...boxed, text: reason })} className="rounded border border-slate-200 px-2 py-1 text-xs hover:bg-slate-100">{reason}</button>)}
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
                          placeholder="Add a reason (optional)"
                          rows={2}
                          className="w-full rounded border border-slate-300 px-1.5 py-1 text-xs outline-none focus:border-accent"
                        />
                        {boxed.error && <p className="text-xs text-red-600">{boxed.error}</p>}
                        <div className="flex gap-1.5">
                          <button
                            type="button"
                            disabled={boxed.pending}
                            onClick={() => void submitDecision(row.id, boxed.kind, boxed.text)}
                            className="rounded bg-accent px-2 py-0.5 text-xs font-medium text-white disabled:opacity-40"
                          >
                            {boxed.pending ? "Saving…" : "Save"}
                          </button>
                          <button type="button" disabled={boxed.pending} onClick={() => setReasonBox(null)} className="rounded px-2 py-0.5 text-xs text-slate-500 hover:bg-slate-100">
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : row.decision ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={decisionTone(row.decision.decision)}>{row.decision.decision === "apply" ? "User-shortlisted" : "User-dismissed"}</Badge>
                        {row.decision.reason && <p className="w-full text-sm text-slate-600">{row.decision.reason}</p>}
                        <button type="button" onClick={() => openReasonBox(row.id, row.decision!.decision, row.decision!.reason)} className="text-xs text-slate-500 underline hover:text-slate-800">
                          Reconsider
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            void submitDecision(row.id, null, "");
                          }}
                          className="text-xs text-slate-500 underline hover:text-slate-800"
                        >
                          Reset my decision
                        </button>
                      </div>
                    ) : (
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => void submitDecision(row.id, "apply", "")}
                          className="rounded bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
                        >
                          Shortlist
                        </button>
                        <button
                          type="button"
                          onClick={() => openReasonBox(row.id, "skip")}
                          className="rounded bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 hover:bg-red-100"
                        >
                          Dismiss
                        </button>
                      </div>
                    )}
                    <button type="button" disabled={archivingId !== null || reasonBox?.pending} onClick={() => void archiveRow(row.id)} className="mt-2 text-xs text-slate-500 underline disabled:opacity-40">{archivingId === row.id ? "Saving…" : archived ? "Restore" : "Archive"}</button>
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
