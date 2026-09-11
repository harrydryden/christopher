"use client";

import { startTransition, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { decide, archiveRoles } from "@/app/actions/decisions";
import { Badge, decisionTone, jobStatusTone } from "@/components/Badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/table";
import type { RoleRowVM } from "@/lib/queries/jobs";
import { truncate } from "@/lib/format";

type ReasonKind = "apply" | "skip";

interface ReasonBoxState {
  jobId: string;
  kind: ReasonKind;
  text: string;
  pending: boolean;
  error: string | null;
}

function FitBar({ score }: { score: number | null }) {
  if (score === null) return <span className="text-slate-400">—</span>;
  const tone = score >= 70 ? "bg-emerald-500" : score >= 30 ? "bg-amber-500" : "bg-red-400";
  return (
    <div className="flex items-center gap-2">
      <span className="w-6 text-right tabular-nums text-slate-700 dark:text-slate-200">{score}</span>
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-slate-150 dark:bg-slate-800">
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${Math.max(2, Math.min(100, score))}%` }} />
      </span>
    </div>
  );
}

function ExternalLinkIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true" className="inline-block">
      <path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M9.5 2H14v4.5M14 2 7 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function RolesTable({ rows: inputRows, keyboard = false, archived = false, emptyState }: { archived?: boolean; rows: RoleRowVM[]; keyboard?: boolean; emptyState: React.ReactNode }) {
  const router = useRouter();
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const rows = inputRows.filter(row => !removedIds.has(row.id));
  const [archivingId, setArchivingId] = useState<string | null>(null);
  function archiveRow(id: string) {
    startTransition(async () => {
    setArchivingId(id); setFlashError(null);
    try {
      const result = await archiveRoles([id], !archived);
      if (!result.ok) setFlashError(result.error);
      else setRemovedIds(ids => new Set([...ids, id]));
      router.refresh();
    } catch { setFlashError("Could not save. Reload to check the current state before retrying."); }
    finally { setArchivingId(null); }
    });
  }
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [reasonBox, setReasonBox] = useState<ReasonBoxState | null>(null);
  const [flashError, setFlashError] = useState<string | null>(null);
  const reasonBoxRef = useRef(reasonBox);
  reasonBoxRef.current = reasonBox;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  function openReasonBox(jobId: string, kind: ReasonKind, prefill = "") {
    setReasonBox({ jobId, kind, text: prefill, pending: false, error: null });
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function submitDecision(jobId: string, decision: ReasonKind | null, reason: string) {
    startTransition(async () => {
    setFlashError(null);
    const isBoxed = reasonBoxRef.current?.jobId === jobId;
    if (isBoxed) setReasonBox((b) => (b ? { ...b, pending: true, error: null } : b));
    const result = await decide(jobId, decision, reason);
    if (!result.ok) {
      if (isBoxed) setReasonBox((b) => (b ? { ...b, pending: false, error: result.error } : b));
      else setFlashError(result.error);
      return;
    }
    if (isBoxed) setReasonBox(null);
    router.refresh();
    });
  }

  // Keyboard nav: only for the primary table (the daily-inbox view). Ignored while typing.
  useEffect(() => {
    if (!keyboard) return;
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isEditable = !!target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "BUTTON" || target.tagName === "A" || target.isContentEditable);

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
      {keyboard && <p className="mb-3 text-xs text-slate-500">Keyboard: <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>a</kbd> shortlist · <kbd>s</kbd> skip · <kbd>o</kbd> open</p>}
      {flashError && (
        <p className="mb-2 rounded-md bg-red-50 px-3 py-1.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{flashError}</p>
      )}
      <Table>
        <THead>
          <tr>
            <TH>Company</TH>
            <TH className="w-8" />
            <TH>Role</TH>
            <TH>Location</TH>
            <TH>Live for</TH>
            <TH>Status</TH>
            <TH>Fit</TH>
            <TH>Decision</TH>
          </tr>
        </THead>
        <TBody>
          {rows.map((row, index) => {
            const boxed = reasonBox?.jobId === row.id ? reasonBox : null;
            return (
                <TR key={row.id} highlighted={index === highlightIndex}>
                  <TD id={`role-row-${row.id}`}>
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
                        <span className="inline-block h-3.5 w-3.5 rounded-sm bg-slate-200 dark:bg-slate-700" />
                      )}
                      <span className="max-w-[12rem] truncate">{row.companyName}</span>
                    </a>
                  </TD>
                  <TD className="w-8 px-1 text-center">
                    <a
                      href={row.companyHomepageUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={row.companyHomepageUrl}
                      className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                    >
                      <ExternalLinkIcon />
                    </a>
                  </TD>
                  <TD className="max-w-[22rem]">
                    <a href={row.url} target="_blank" rel="noopener noreferrer" className="font-medium text-slate-900 hover:underline dark:text-slate-100">
                      {row.title}
                    </a>
                    <p className="mt-1 text-xs text-slate-500">{[row.department, row.employmentType, row.salaryText].filter(Boolean).join(" · ")}</p>
                    <a href={`/cv?job=${row.id}`} className="mt-2 inline-block text-xs underline">Build CV</a>
                  </TD>
                  <TD className="max-w-[10rem]">
                    <div className="flex flex-wrap items-center gap-1">
                      <span>{row.locations.length ? row.locations.join(", ") : row.location}</span>
                      {row.remote && <Badge tone="blue">Remote</Badge>}
                      {!row.location && row.locations.length === 0 && !row.remote && <span className="text-slate-400">—</span>}
                    </div>
                  </TD>
                  <TD className="whitespace-nowrap">
                    <span title={row.liveForTitle}>{row.liveForText}</span>
                  </TD>
                  <TD>
                    <Badge tone={jobStatusTone(row.status)}>{row.status}</Badge>
                  </TD>
                  <TD className="min-w-[12rem] max-w-xs">
                    <FitBar score={row.fitScore} />
                    {row.fitRationale && <p className="mt-1 text-xs text-slate-500">{row.fitRationale}</p>}
                  </TD>
                  <TD className="min-w-[14rem]">
                    {boxed ? (
                      <div className="flex flex-col gap-1.5">
                        <div className="flex gap-1">
                          <button
                            type="button"
                            onClick={() => setReasonBox({ ...boxed, kind: "apply" })}
                            className={`rounded px-1.5 py-0.5 text-xs font-medium ${boxed.kind === "apply" ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"}`}
                          >
                            Shortlist
                          </button>
                          <button
                            type="button"
                            onClick={() => setReasonBox({ ...boxed, kind: "skip" })}
                            className={`rounded px-1.5 py-0.5 text-xs font-medium ${boxed.kind === "skip" ? "bg-red-600 text-white" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"}`}
                          >
                            Skip
                          </button>
                        </div>
                        <textarea
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
                              if (!(boxed.kind === "skip" && boxed.text.trim() === "")) void submitDecision(row.id, boxed.kind, boxed.text);
                            }
                          }}
                          placeholder={boxed.kind === "skip" ? "Why? (required)" : "Why? (optional)"}
                          rows={2}
                          className="w-full rounded border border-slate-300 px-1.5 py-1 text-xs outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-950"
                        />
                        {boxed.error && <p className="text-xs text-red-600 dark:text-red-400">{boxed.error}</p>}
                        <div className="flex gap-1.5">
                          <button
                            type="button"
                            disabled={boxed.pending || (boxed.kind === "skip" && boxed.text.trim() === "")}
                            onClick={() => void submitDecision(row.id, boxed.kind, boxed.text)}
                            className="rounded bg-slate-900 px-2 py-0.5 text-xs font-medium text-white disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
                          >
                            {boxed.pending ? "Saving…" : "Save"}
                          </button>
                          <button type="button" onClick={() => setReasonBox(null)} className="rounded px-2 py-0.5 text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : row.decision ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={decisionTone(row.decision.decision)}>{row.decision.decision === "apply" ? "shortlisted" : "skipped"}</Badge>
                        <span title={row.decision.reason} className="max-w-[8rem] truncate text-xs text-slate-500 dark:text-slate-400">
                          {row.decision.reason ? truncate(row.decision.reason, 40) : <em>no reason</em>}
                        </span>
                        <button type="button" onClick={() => openReasonBox(row.id, row.decision!.decision, row.decision!.reason)} className="text-xs text-slate-500 underline hover:text-slate-800 dark:hover:text-slate-200">
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (confirm("Undo this decision?")) void submitDecision(row.id, null, "");
                          }}
                          className="text-xs text-slate-500 underline hover:text-slate-800 dark:hover:text-slate-200"
                        >
                          Undo
                        </button>
                      </div>
                    ) : (
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => openReasonBox(row.id, "apply")}
                          className="rounded bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-300"
                        >
                          Shortlist
                        </button>
                        <button
                          type="button"
                          onClick={() => openReasonBox(row.id, "skip")}
                          className="rounded bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 hover:bg-red-100 dark:bg-red-950 dark:text-red-300"
                        >
                          Skip
                        </button>
                      </div>
                    )}
                    <button type="button" disabled={archivingId !== null} onClick={() => void archiveRow(row.id)} className="mt-2 text-xs text-slate-500 underline disabled:opacity-40">{archivingId === row.id ? "Saving…" : archived ? "Restore" : "Archive"}</button>
                  </TD>
                </TR>
            );
          })}
        </TBody>
      </Table>
    </div>
  );
}
