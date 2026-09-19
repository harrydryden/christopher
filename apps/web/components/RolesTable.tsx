"use client";

import { Fragment, startTransition, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { decide, decideRoles, archiveRoles, roleDetails } from "@/app/actions/decisions";
import { Badge, decisionTone, fitVerdictTone, stageTone, FIT_VERDICT_LABELS } from "@/components/Badge";
import { CompanyFavicon } from "@/components/CompanyFavicon";
import { FitBar, Table, TBody, TD, TH, THead, TR } from "@/components/table";
import { Button, buttonClass } from "@/components/Button";
import { Mark } from "@/components/brand/Mark";
import { SafeMarkdown } from "@/components/SafeMarkdown";
import type { RoleDetailsVM, RoleRowVM, SortDir, SortKey } from "@/lib/queries/jobs";

import { APPLICATION_STATUS_LABELS, ROLE_STAGE_LABELS, ROLE_STATUS_LABELS, roleStageRank } from "@christopher/core/role-workflow";

type ReasonKind = "apply" | "skip";

/** How long the undo notice stays. Long enough to read a line and reach for it, short enough to leave. */
const NOTICE_MS = 5000;

/** Roughly what fits in the collapsed height; below it there is nothing to show more of. */
const COLLAPSED_DESCRIPTION_CHARS = 400;

/** The nudge R-6.1 asks for: a reason on apply is wanted, never required. */
const APPLY_REASON_HINT = "One line on why helps the ranking. Enter to skip.";

/** "In process · Interview": the stage, and — for the three steps it collapses — which one. */
function stageLabel(row: RoleRowVM): string {
  const label = ROLE_STAGE_LABELS[row.stage];
  return row.stage === "in_process" && row.applicationStatus ? `${label} · ${APPLICATION_STATUS_LABELS[row.applicationStatus]}` : label;
}

/** A shortlisted role that has moved on: the badge beside the title says where to. */
function movedOn(row: RoleRowVM): boolean {
  return row.workflowStatus === "user-shortlisted" && roleStageRank(row.stage) > roleStageRank("shortlisted");
}

/**
 * The same destination either way — the application row is where the CV lives — but it is only a
 * CV to build until there is one; from Applying on, the row is an application to open.
 */
function applicationLabel(row: RoleRowVM): string {
  return roleStageRank(row.stage) >= roleStageRank("applying") ? "Open application" : "Build CV";
}

/** What the score says, for the `title` on the bar: the verdict, then the rationale behind it. */
function fitTitle(row: RoleRowVM): string | undefined {
  const parts = [row.fitVerdict ? FIT_VERDICT_LABELS[row.fitVerdict] : null, row.fitRationale].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

/** Descriptions arrive as cleaned text; some sources hand over headings and bullets. */
function looksMarkdown(text: string): boolean {
  return /^\s*(#{1,3}\s|[-*]\s)/m.test(text) || /\*\*[^*]+\*\*/.test(text);
}

type DetailState =
  | { state: "loading" }
  | { state: "ready"; details: RoleDetailsVM }
  | { state: "error"; error: string };

interface ReasonBoxState {
  jobId: string;
  kind: ReasonKind;
  text: string;
  pending: boolean;
  error: string | null;
}

/** A column head that sorts (R-7.1). The link carries the filters in hand, so sorting keeps them. */
function SortTH({ label, sortKey, links, sort, dir, className = "" }: {
  label: string; sortKey: SortKey; links?: Partial<Record<SortKey, string>>; sort?: SortKey; dir?: SortDir; className?: string;
}) {
  const href = links?.[sortKey];
  if (!href) return <TH className={className}>{label}</TH>;
  const active = sort === sortKey;
  return (
    <TH className={className} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <a href={href} title={`Sort by ${label.toLowerCase()}`} className={`no-underline hover:underline ${active ? "text-fg" : ""}`}>
        {label}
        {active && <span aria-hidden="true">{dir === "asc" ? " ↑" : " ↓"}</span>}
      </a>
    </TH>
  );
}

export function RolesTable({ rows: inputRows, hideCompany = false, keyboard = false, archived = false, emptyState, sortLinks, sort, dir }: {
  hideCompany?: boolean; archived?: boolean; rows: RoleRowVM[]; keyboard?: boolean; emptyState: React.ReactNode;
  /** One href per sortable column, built by the server with the filters in hand. */
  sortLinks?: Partial<Record<SortKey, string>>;
  sort?: SortKey;
  dir?: SortDir;
}) {
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectedIds = rows.filter(row => selected.has(row.id)).map(row => row.id);
  const allSelected = rows.length > 0 && selectedIds.length === rows.length;
  const [groupReason, setGroupReason] = useState<string | null>(null);
  const [groupPending, setGroupPending] = useState<string | null>(null);
  const [groupError, setGroupError] = useState<string | null>(null);
  const groupBusy = groupPending !== null;

  function toggleSelected(id: string) {
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  /** One call for the whole selection: it is saved together or not at all. */
  function runGroup(label: string, run: () => Promise<{ ok: true; message?: string } | { ok: false; error: string }>, leaving: (row: RoleRowVM) => boolean) {
    if (groupBusy || selectedIds.length === 0) return;
    const ids = selectedIds;
    setGroupPending(label); setGroupError(null); setFlashError(null);
    startTransition(async () => {
      try {
        const result = await run();
        if (!result.ok) { setGroupError(result.error); return; }
        const gone = inputRows.filter(row => ids.includes(row.id) && leaving(row)).map(row => row.id);
        setRemovedIds(previous => new Set([...previous, ...gone]));
        setSelected(new Set());
        setGroupReason(null);
        router.refresh();
      } catch {
        setGroupError("Could not save. Reload to check the current state before retrying.");
      } finally { setGroupPending(null); }
    });
  }

  function submitGroupDecision(decision: "apply" | "skip" | null, reason: string) {
    const ids = selectedIds;
    runGroup(decision === null ? "Undoing…" : "Saving…", () => decideRoles(ids, decision, reason),
      row => archived || (row.decision?.decision ?? null) !== decision);
  }

  // The cursor starts on the first row rather than nowhere, so the first `a` or `s` acts on
  // something and the shortcuts under the table are about a row the reader can see.
  const [highlightIndex, setHighlightIndex] = useState(keyboard && inputRows.length > 0 ? 0 : -1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, DetailState>>({});
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const [reasonBox, setReasonBox] = useState<ReasonBoxState | null>(null);
  const [flashError, setFlashError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ jobId: string; text: string } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reasonBoxRef = useRef(reasonBox);
  reasonBoxRef.current = reasonBox;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  /** One notice at a time: the newest decision replaces whatever was there. */
  function showNotice(jobId: string, text: string) {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice({ jobId, text });
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }
  function clearNotice() {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = null;
    setNotice(null);
  }
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  /** The evidence a decision needs, fetched once per row when it expands and kept for the page. */
  function loadDetails(jobId: string) {
    setDetails(current => ({ ...current, [jobId]: { state: "loading" } }));
    startTransition(async () => {
      try {
        const result = await roleDetails(jobId);
        setDetails(current => ({ ...current, [jobId]: result.ok ? { state: "ready", details: result.details } : { state: "error", error: result.error } }));
      } catch {
        setDetails(current => ({ ...current, [jobId]: { state: "error", error: "Could not load this role. Reload and try again." } }));
      }
    });
  }

  function toggleExpanded(jobId: string) {
    const next = expandedId === jobId ? null : jobId;
    setExpandedId(next);
    setReasonBox(null);
    setDescriptionOpen(false);
    if (next && !details[next]) loadDetails(next);
  }

  function openReasonBox(jobId: string, kind: ReasonKind, prefill = "") {
    if (expandedId !== jobId) {
      setExpandedId(jobId);
      setDescriptionOpen(false);
      if (!details[jobId]) loadDetails(jobId);
    }
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
    // The row leaves the page the moment it is decided; the notice says where it went and offers
    // the way back, so nothing vanishes without a word.
    if (decision === null) clearNotice();
    else if (previous) showNotice(jobId, `${decision === "apply" ? "Shortlisted" : "Dismissed"} ${previous.title}${hideCompany ? "" : ` at ${previous.companyName}`}`);
    router.refresh();
    } catch {
      const error = "Could not save. Reload to check the current state before retrying.";
      if (isBoxed) setReasonBox(b => b?.jobId === jobId ? { ...b, pending: false, error } : b);
      else setFlashError(error);
    } finally { actionsInFlight.current.delete(jobId); }
    });
  }

  /** The notice's way back: the decision is undone and the row returns to the page it left. */
  function undoDecision(jobId: string) {
    if (actionsInFlight.current.has(jobId)) return;
    actionsInFlight.current.add(jobId);
    clearNotice();
    startTransition(async () => {
      setFlashError(null);
      try {
        const result = await decide(jobId, null, "");
        if (!result.ok) { setFlashError(result.error); return; }
        setRemovedIds(ids => { const next = new Set(ids); next.delete(jobId); return next; });
        router.refresh();
      } catch {
        setFlashError("Could not save. Reload to check the current state before retrying.");
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
        case "x":
          if (row) { e.preventDefault(); toggleSelected(row.id); }
          break;
        case "o":
          if (row) window.open(row.url, "_blank", "noopener,noreferrer");
          break;
        case "a":
          // R-6.1: shortlisting asks for a line rather than taking the decision silently. Enter on
          // an empty box shortlists anyway, so the one-keystroke path is still one keystroke and
          // a return.
          if (row) { e.preventDefault(); openReasonBox(row.id, "apply", row.decision?.decision === "apply" ? row.decision.reason : ""); }
          break;
        case "s":
          if (row) { e.preventDefault(); openReasonBox(row.id, "skip", row.decision?.decision === "skip" ? row.decision.reason : ""); }
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

  const undoNotice = notice && (
    <p role="status" aria-live="polite" className="mt-3 flex flex-wrap items-center gap-3 border-2 border-line-muted px-3 py-1.5 text-13 text-fg">
      <span>{notice.text}</span>
      <button type="button" onClick={() => undoDecision(notice.jobId)} className="text-13 font-semibold underline hover:text-muted">Undo</button>
    </p>
  );

  if (rows.length === 0 && !notice) return <>{emptyState}</>;
  if (rows.length === 0) return <div>{emptyState}{undoNotice}</div>;

  return (
    <div>
      {flashError && (
        <p className="mb-2 border-2 border-danger px-3 py-1.5 text-14 text-danger">{flashError}</p>
      )}
      {selectedIds.length > 0 && (
        <div role="group" aria-label="Actions for the selected roles" className="mb-3 flex flex-col gap-2 border-2 border-line bg-sunken px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="ds-label" aria-live="polite">{selectedIds.length} selected</span>
            {groupReason === null ? (
              <>
                <Button size="sm" variant="primary" disabled={groupBusy} onClick={() => submitGroupDecision("apply", "")}>Shortlist</Button>
                <Button size="sm" disabled={groupBusy} onClick={() => { setGroupError(null); setGroupReason(""); }}>Dismiss</Button>
                <Button size="sm" variant="ghost" disabled={groupBusy} onClick={() => submitGroupDecision(null, "")}>Undo decisions</Button>
                <Button size="sm" variant="ghost" disabled={groupBusy}
                  onClick={() => runGroup(archived ? "Restoring…" : "Archiving…", () => archiveRoles(selectedIds, !archived), () => true)}>
                  {archived ? "Restore" : "Archive"}
                </Button>
                <Button size="sm" variant="ghost" disabled={groupBusy} onClick={() => { setSelected(new Set()); setGroupError(null); }}>Clear</Button>
                {groupPending && <span className="text-12 text-muted">{groupPending}</span>}
              </>
            ) : (
              <>
                {["Wrong location", "Wrong seniority", "Not interested"].map(reason => (
                  <Button key={reason} size="sm" variant="ghost" disabled={groupBusy} onClick={() => setGroupReason(reason)}>{reason}</Button>
                ))}
              </>
            )}
          </div>
          {groupReason !== null && (
            <div className="flex flex-col gap-2">
              <label className="ds-label" htmlFor="group-reason">One reason for all {selectedIds.length}</label>
              <textarea
                id="group-reason"
                value={groupReason}
                disabled={groupBusy}
                rows={2}
                onChange={event => setGroupReason(event.target.value)}
                onKeyDown={event => {
                  if (event.key === "Escape") { event.stopPropagation(); setGroupReason(null); event.currentTarget.blur(); }
                  else if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); submitGroupDecision("skip", groupReason); }
                }}
                placeholder="Why are these not for you? (required)"
                className="w-full resize-y border-2 border-line-muted bg-bg px-2 py-1 font-mono text-12 text-fg placeholder:text-faint focus:border-line focus:outline-none"
              />
              <div className="flex gap-2">
                <Button size="sm" variant="primary" disabled={groupBusy} onClick={() => submitGroupDecision("skip", groupReason)}>
                  {groupBusy ? groupPending : `Dismiss ${selectedIds.length}`}
                </Button>
                <Button size="sm" variant="ghost" disabled={groupBusy} onClick={() => { setGroupReason(null); setGroupError(null); }}>Cancel</Button>
              </div>
            </div>
          )}
          {groupError && <p className="text-12 text-danger">{groupError}</p>}
        </div>
      )}
      <Table>
        <THead>
          <tr>
            <TH className="w-8">
              <input
                type="checkbox"
                className="h-4 w-4 m-0 align-middle"
                aria-label="Select every role on this page"
                aria-checked={allSelected ? "true" : selectedIds.length ? "mixed" : "false"}
                checked={allSelected}
                disabled={groupBusy}
                ref={element => { if (element) element.indeterminate = selectedIds.length > 0 && !allSelected; }}
                onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map(row => row.id)))}
              />
            </TH>
            {!hideCompany && <SortTH label="Company" sortKey="company" links={sortLinks} sort={sort} dir={dir} />}
            <SortTH label="Role" sortKey="title" links={sortLinks} sort={sort} dir={dir} />
            <SortTH label="Location" sortKey="location" links={sortLinks} sort={sort} dir={dir} />
            <SortTH label="Fit" sortKey="fit" links={sortLinks} sort={sort} dir={dir} />
            <TH><span className="sr-only">Action</span></TH>
          </tr>
        </THead>
        <TBody>
          {rows.map((row, index) => {
            const boxed = reasonBox?.jobId === row.id ? reasonBox : null;
            const detail = details[row.id];
            return (
              <Fragment key={row.id}>
                <TR highlighted={index === highlightIndex} className={selected.has(row.id) ? "bg-sunken" : ""}>
                  <TD>
                    <input
                      type="checkbox"
                      className="h-4 w-4 m-0 mt-0.5 align-middle"
                      aria-label={`Select ${row.title}${hideCompany ? "" : ` at ${row.companyName}`}`}
                      aria-checked={selected.has(row.id)}
                      checked={selected.has(row.id)}
                      disabled={groupBusy}
                      onChange={() => toggleSelected(row.id)}
                    />
                  </TD>
                  {!hideCompany && <TD>
                    <a href={`/companies/${row.companyId}`} className="flex items-center gap-1.5 no-underline hover:underline">
                      {/* The same icon the company page shows: the captured logo when there is one,
                          and the browser's own chain behind it. A bare <img> here is why Hims had a
                          logo on its company page and a blank square on its roles. */}
                      <CompanyFavicon src={row.companyLogoUrl ?? row.companyFaviconUrl} domain={row.companyDomain} size={14} />
                      <span className="max-w-[12rem] truncate">{row.companyName}</span>
                    </a>
                  </TD>}
                  <TD id={`role-row-${row.id}`} className="max-w-[22rem]">
                    <span className="flex flex-wrap items-center gap-2">
                      <button type="button" disabled={reasonBox?.pending} onClick={() => toggleExpanded(row.id)} aria-expanded={expandedId === row.id} className="text-left font-semibold text-fg hover:underline">
                        {row.title}
                      </button>
                      {row.addedByYou && <Badge tone="neutral">Added by you</Badge>}
                      {/* Where a shortlisted role has got to, on the row rather than only inside it. */}
                      {movedOn(row) && <Badge tone={stageTone(row.stage)}>{stageLabel(row)}</Badge>}
                    </span>
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
                    <FitBar score={row.fitScore} title={fitTitle(row)} />
                  </TD>
                  <TD className="text-right">
                    {row.workflowStatus === "user-shortlisted" ? <a href={`/applications?job=${row.id}`} className={buttonClass("secondary", "sm", "whitespace-nowrap no-underline")}>{applicationLabel(row)}</a>
                    : archived ? <Button size="sm" disabled={archivingId !== null || reasonBox?.pending} onClick={() => void archiveRow(row.id)}>{archivingId === row.id ? "Restoring…" : "Restore"}</Button>
                    : <Button
                      size="sm"
                      aria-expanded={expandedId === row.id}
                      aria-controls={`role-review-${row.id}`}
                      aria-label={`${expandedId === row.id ? "Close review for" : "Review"} ${row.title} at ${row.companyName}`}
                      disabled={reasonBox?.pending}
                      onClick={() => toggleExpanded(row.id)}
                    >
                      {expandedId === row.id ? "Close" : row.workflowStatus === "user-dismissed" ? "Reconsider" : "Review"}
                    </Button>}
                  </TD>
                </TR>
                {expandedId === row.id && (
                  <tr id={`role-review-${row.id}`} className="bg-sunken">
                    <td colSpan={hideCompany ? 5 : 6} className="p-4">
                      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(256px,352px)]">
                        <div className="space-y-3">
                          <p className="text-14 font-semibold text-fg">{row.title}</p>
                          <p className="text-12 text-muted">{[row.department, row.employmentType].filter(Boolean).join(" · ")}</p>
                          {row.salaryText && <p className="text-14 text-fg"><span className="ds-label mr-2">Salary</span>{row.salaryText}</p>}
                          <div>
                            <h3 className="ds-label mb-1">Why this is here</h3>
                            {row.keywordTerms.length > 0 && (
                              <div className="mb-1 flex flex-wrap gap-1.5">
                                {row.keywordTerms.map(term => <Badge key={term} tone="gray" title="A keyword of yours that this role matched">{term}</Badge>)}
                              </div>
                            )}
                            {detail?.state === "ready" && <p className="text-13 text-muted">{detail.details.locationReason}</p>}
                          </div>
                          {row.fitScore !== null && (
                            <div>
                              <h3 className="ds-label mb-1">Fit</h3>
                              <div className="flex flex-wrap items-center gap-2">
                                <FitBar score={row.fitScore} title={fitTitle(row)} />
                                {row.fitVerdict && <Badge tone={fitVerdictTone(row.fitVerdict)}>{FIT_VERDICT_LABELS[row.fitVerdict]}</Badge>}
                              </div>
                              {row.fitRationale && <p className="mt-1 max-w-3xl text-14 text-fg">{row.fitRationale}</p>}
                            </div>
                          )}
                          <div>
                            <h3 className="ds-label mb-1">Role description</h3>
                            {detail?.state === "loading" && <span className="inline-block text-muted"><Mark size={16} searching title="Loading the description" /></span>}
                            {detail?.state === "error" && <p className="text-13 text-danger">{detail.error}</p>}
                            {detail?.state === "ready" && (detail.details.description?.trim() ? (
                              <>
                                <div className={descriptionOpen || detail.details.description.length <= COLLAPSED_DESCRIPTION_CHARS ? "" : "max-h-32 overflow-hidden"}>
                                  {looksMarkdown(detail.details.description)
                                    ? <SafeMarkdown markdown={detail.details.description} className="max-w-3xl" />
                                    : <div className="max-w-3xl space-y-2.5 text-14 leading-relaxed text-fg">
                                        {detail.details.description.split(/\n{2,}/).map((paragraph, i) => <p key={i}>{paragraph.trim()}</p>)}
                                      </div>}
                                </div>
                                {detail.details.description.length > COLLAPSED_DESCRIPTION_CHARS && (
                                  <button type="button" onClick={() => setDescriptionOpen(open => !open)} className="mt-1 text-12 text-muted underline hover:text-fg">
                                    {descriptionOpen ? "Show less" : "Show more"}
                                  </button>
                                )}
                              </>
                            ) : (
                              <p className="text-13 text-muted">No description stored yet. Open the vacancy to read it.</p>
                            ))}
                          </div>
                          {row.events.filter(event => event.label.includes("archiv")).map(event => <p key={event.id} className="text-12 text-muted">{event.label}</p>)}
                          <div className="flex flex-wrap items-center gap-4 text-12">
                            <a href={`/applications?job=${row.id}`} className="font-semibold underline">{applicationLabel(row)}</a>
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
                            } else if (e.key === "Enter" && !e.shiftKey) {
                              // R-7.2: enter saves. Shift+Enter is still a new line, and an empty
                              // box on a shortlist saves the decision without a reason.
                              e.preventDefault();
                              if (!boxed.pending) void submitDecision(row.id, boxed.kind, boxed.text);
                            }
                          }}
                          placeholder={boxed.kind === "skip" ? "Why is this not for you? (required)" : APPLY_REASON_HINT}
                          rows={boxed.kind === "skip" ? 2 : 1}
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
                        <Badge tone={decisionTone(row.decision.decision)}>{ROLE_STATUS_LABELS[row.decision.decision === "apply" ? "user-shortlisted" : "user-dismissed"]}</Badge>
                        {movedOn(row) && <Badge tone={stageTone(row.stage)}>{stageLabel(row)}</Badge>}
                        <span className="text-12 text-muted" title={row.decision.createdTitle}>Decided {row.decision.createdLabel}</span>
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
      {undoNotice}
      {/* The shortcuts are the table's own caption, not a disclosure nobody opens. */}
      {keyboard && <p className="mt-3 text-12 text-muted">
        <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>x</kbd> select · <kbd>a</kbd> shortlist · <kbd>s</kbd> dismiss · <kbd>o</kbd> open · <kbd>enter</kbd> save
      </p>}
    </div>
  );
}
