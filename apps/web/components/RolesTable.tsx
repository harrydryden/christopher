"use client";

import { Fragment, startTransition, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { decide, decideRoles, archiveRoles, roleDetails } from "@/app/actions/decisions";
import { requestCv } from "@/app/actions/cv";
import { Badge, decisionTone, fitVerdictTone, stageTone, FIT_VERDICT_LABELS } from "@/components/Badge";
import { CompanyFavicon } from "@/components/CompanyFavicon";
import { FitBar, Table, TBody, TD, TH, THead, TR } from "@/components/table";
import { Button, buttonClass } from "@/components/Button";
import { Monogram } from "@/components/brand/Monogram";
import { SafeMarkdown } from "@/components/SafeMarkdown";
import { SettingsForm } from "@/components/SettingsForm";
import type { RoleDetailsVM, RoleRowVM, SortDir, SortKey } from "@/lib/queries/jobs";
import { missingDecisionReason } from "@/lib/decision-reason";
import { reportRoleRefusal } from "@/lib/role-refusals";

import { APPLICATION_STATUS_LABELS, ROLE_STAGE_DESCRIPTIONS, ROLE_STAGE_LABELS, ROLE_STATUS_LABELS, roleStageRank } from "@ava/core/role-workflow";

type ReasonKind = "apply" | "skip";

/** How long the undo notice stays. Long enough to read a line and reach for it, short enough to leave. */
const NOTICE_MS = 5000;

/** Roughly what fits in the collapsed height; below it there is nothing to show more of. */
const COLLAPSED_DESCRIPTION_CHARS = 400;

/** The nudge R-6.1 asks for: a reason on apply is wanted, never required. */
const APPLY_REASON_HINT = "One line on why helps the ranking (optional)";

function withId(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  return ids.has(id) ? ids : new Set(ids).add(id);
}
function withoutId(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!ids.has(id)) return ids;
  const next = new Set(ids);
  next.delete(id);
  return next;
}

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

/**
 * The build offered where the role was shortlisted, priced before it is pressed (3.5).
 *
 * The quote rides in on the panel's own round trip, so this costs no extra request. A budget that
 * will not take the build says so here instead of on a CV page after the redirect, an account with
 * nothing in its Library is sent to the Library rather than to a price, and an unconfirmed address
 * disables the button with the sentence the rest of the product uses. `requestCv` redirects to the
 * new CV on success, which is the one click this recommendation is about.
 */
function BuildCvOffer({ jobId, details }: { jobId: string; details: RoleDetailsVM }) {
  if (!details.cvQuote)
    return (
      <p className="text-12 text-muted">
        Save your Library first. <Link prefetch={false} href="/library" className="underline">Open Library</Link>
      </p>
    );
  if (details.cvQuote.refusal) return <p className="text-12 text-warn" role="status">{details.cvQuote.refusal}</p>;
  const label = `Build a CV for this role · ${details.cvQuote.line}`;
  if (details.cvBlocked)
    return (
      <div className="flex flex-col gap-2">
        <div><Button size="sm" variant="primary" disabled aria-describedby={`cv-blocked-${jobId}`}>{label}</Button></div>
        <p id={`cv-blocked-${jobId}`} className="text-12 text-warn">{details.cvBlocked}</p>
      </div>
    );
  return (
    <SettingsForm action={requestCv} submitLabel={label}>
      <input type="hidden" name="jobId" value={jobId} />
    </SettingsForm>
  );
}

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
      <Link prefetch={false} href={href} title={`Sort by ${label.toLowerCase()}`} className={`no-underline hover:underline ${active ? "text-fg" : ""}`}>
        {label}
        {active && <span aria-hidden="true">{dir === "asc" ? " ↑" : " ↓"}</span>}
      </Link>
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
  // Rows leave the page the moment they are decided, before the server answers; a refusal puts
  // them back. `removedIds` is what has left; `returning` is what an undo has brought back before
  // the page the undo re-renders arrives, drawn from `departed`, the rows as they were when they left.
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [returning, setReturning] = useState<ReadonlySet<string>>(() => new Set());
  const departed = useRef(new Map<string, { row: RoleRowVM; index: number }>());
  const returningRef = useRef(returning);
  returningRef.current = returning;
  const rows = useMemo(() => {
    const list = inputRows.filter(row => !removedIds.has(row.id));
    for (const id of returning) {
      const gone = departed.current.get(id);
      if (!gone || removedIds.has(id) || list.some(row => row.id === id)) continue;
      list.splice(Math.min(gone.index, list.length), 0, gone.row);
    }
    return list;
  }, [inputRows, removedIds, returning]);
  /** One write per row at a time; each entry settles true when that write was saved. */
  const inFlight = useRef(new Map<string, Promise<boolean>>());
  // The same rows, for rendering: a row with a write out has its actions disabled and its shortcuts
  // ignored, so a press is never dropped without a sign (an undo brings a row back before it is saved).
  const [writing, setWriting] = useState<ReadonlySet<string>>(() => new Set());
  function track(id: string, run: Promise<boolean>) {
    inFlight.current.set(id, run);
    setWriting(ids => withId(ids, id));
  }
  // A returned row is held in place only until the page its undo re-renders has arrived. The first
  // new page after the undo settled carries the server's answer, so from then on the row shows only
  // if the server lists it: held longer, a row the server later drops (decided in another tab,
  // closed by a scan) would be put back on the page from memory.
  useEffect(() => {
    // Rows kept only for an undo nobody can press any more (the notice has moved on) are let go too.
    for (const id of departed.current.keys()) {
      if (id !== noticeRef.current?.jobId && !inFlight.current.has(id) && !returningRef.current.has(id)) departed.current.delete(id);
    }
    setReturning(ids => {
      const settled = [...ids].filter(id => !inFlight.current.has(id));
      if (settled.length === 0) return ids;
      for (const id of settled) departed.current.delete(id);
      return new Set([...ids].filter(id => inFlight.current.has(id)));
    });
  }, [inputRows]);
  // The table is keyed on the query and page, so paging or filtering while a write is out replaces
  // it. A refusal that lands after that goes to the workspace's notices, which outlive the table.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  /** True when this table is gone and the refusal was handed to the notices instead. */
  function reportedElsewhere(what: string, error: string): boolean {
    if (mounted.current) return false;
    reportRoleRefusal(what, error);
    return true;
  }
  const titleOf = (id: string) => rows.find(row => row.id === id)?.title ?? departed.current.get(id)?.row.title ?? "this role";

  const [archivingId, setArchivingId] = useState<string | null>(null);
  function archiveRow(id: string) {
    if (inFlight.current.has(id)) return;
    const title = titleOf(id);
    const run = new Promise<boolean>(resolve => startTransition(async () => {
      setArchivingId(id); setFlashError(null);
      let saved = false;
      try {
        const result = await archiveRoles([id], !archived);
        if (!result.ok) { if (!reportedElsewhere(title, result.error)) setFlashError(result.error); }
        else { saved = true; setRemovedIds(ids => withId(ids, id)); }
      } catch {
        const error = "Could not save. Reload and retry.";
        if (!reportedElsewhere(title, error)) setFlashError(error);
      }
      finally { settle(id, run); setArchivingId(null); resolve(saved); }
    }));
    track(id, run);
  }
  /** A row's write is over, unless a later one (an undo queued behind it) has taken its place. */
  function settle(id: string, run: Promise<boolean>) {
    if (inFlight.current.get(id) !== run) return;
    inFlight.current.delete(id);
    setWriting(ids => withoutId(ids, id));
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

  /**
   * One call for the whole selection: it is saved together or not at all. The rows it moves leave
   * at once; if the server refuses, they come back still selected, with its sentence in the bar.
   */
  function runGroup(label: string, run: () => Promise<{ ok: true; message?: string } | { ok: false; error: string }>, leaving: (row: RoleRowVM) => boolean) {
    if (groupBusy || selectedIds.length === 0) return;
    const ids = selectedIds;
    const reason = groupReason;
    const gone = rows.filter(row => ids.includes(row.id) && leaving(row)).map(row => row.id);
    setGroupPending(label); setGroupError(null); setFlashError(null);
    setRemovedIds(previous => new Set([...previous, ...gone]));
    setSelected(new Set());
    setGroupReason(null);
    const putBack = (error: string) => {
      if (reportedElsewhere(ids.length === 1 ? titleOf(ids[0]!) : `${ids.length} roles`, error)) return;
      setRemovedIds(previous => new Set([...previous].filter(id => !gone.includes(id))));
      setSelected(new Set(ids));
      setGroupReason(reason);
      setGroupError(error);
    };
    startTransition(async () => {
      try {
        const result = await run();
        if (!result.ok) putBack(result.error);
      } catch {
        putBack("Could not save. Reload and retry.");
      } finally { setGroupPending(null); }
    });
  }

  function submitGroupDecision(decision: "apply" | "skip" | null, reason: string) {
    const ids = selectedIds;
    // The server refuses this too; asking first keeps the rows where they are.
    const missing = missingDecisionReason(decision, reason);
    if (missing) { setGroupError(missing); return; }
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
  const noticeRef = useRef(notice);
  noticeRef.current = notice;
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
        setDetails(current => ({ ...current, [jobId]: { state: "error", error: "Could not load this role. Reload to retry." } }));
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

  function decidedText(row: RoleRowVM, decision: ReasonKind): string {
    return `${decision === "apply" ? "Shortlisted" : "Dismissed"} ${row.title}${hideCompany ? "" : ` at ${row.companyName}`}`;
  }

  /**
   * Save a decision. A row the decision moves off this page leaves at once, with the notice that
   * says where it went and offers the way back, so nothing vanishes without a word and nobody waits
   * for the server to see it go. The server still decides: if it refuses, the row comes back with
   * its sentence, in the reason box it was typed in or above the table.
   */
  function submitDecision(jobId: string, decision: ReasonKind | null, reason: string) {
    if (inFlight.current.has(jobId)) return;
    const box = reasonBoxRef.current?.jobId === jobId ? reasonBoxRef.current : null;
    setFlashError(null);
    // The server refuses this too; asking first means the common refusal never flashes the row away.
    const missing = missingDecisionReason(decision, reason);
    if (missing) {
      if (box) setReasonBox(b => (b?.jobId === jobId ? { ...b, error: missing } : b));
      else setFlashError(missing);
      return;
    }
    const index = rows.findIndex(row => row.id === jobId);
    const previous = index >= 0 ? rows[index] : undefined;
    const leaves = archived || previous?.decision?.decision !== decision;

    if (leaves) {
      if (previous) departed.current.set(jobId, { row: previous, index });
      setRemovedIds(ids => withId(ids, jobId));
      setReturning(ids => withoutId(ids, jobId));
      if (box) setReasonBox(null);
      if (decision === null) clearNotice();
      else if (previous) showNotice(jobId, decidedText(previous, decision));
    } else if (box) {
      // Re-saving the decision the row already has (a new reason): the row stays, so the box waits.
      setReasonBox(b => (b ? { ...b, pending: true, error: null } : b));
    }

    const title = previous?.title ?? "this role";
    const refused = (error: string) => {
      if (reportedElsewhere(title, error)) return;
      if (leaves) {
        setRemovedIds(ids => withoutId(ids, jobId));
        if (noticeRef.current?.jobId === jobId) clearNotice();
      }
      if (box && !leaves) setReasonBox(b => (b?.jobId === jobId ? { ...b, pending: false, error } : b));
      else if (box && reasonBoxRef.current === null) {
        // Back where it was typed, unless another row's box has been opened since.
        setExpandedId(jobId);
        setReasonBox({ ...box, pending: false, error });
      } else setFlashError(error);
    };

    const run = new Promise<boolean>(resolve => startTransition(async () => {
      let saved = false;
      try {
        const result = await decide(jobId, decision, reason);
        if (!result.ok) { refused(result.error); return; }
        saved = true;
        if (!leaves) {
          if (box) setReasonBox(b => (b?.jobId === jobId ? null : b));
          if (decision === null) clearNotice();
          else if (previous) showNotice(jobId, decidedText(previous, decision));
        }
      } catch {
        refused("Could not save. Reload and retry.");
      } finally { settle(jobId, run); resolve(saved); }
    }));
    track(jobId, run);
  }

  /**
   * The notice's way back: the row returns at once and the decision is undone. Pressed while the
   * decision is still being saved, the undo waits for it, and has nothing to do if it was refused.
   */
  function undoDecision(jobId: string) {
    const prior = inFlight.current.get(jobId);
    clearNotice();
    setFlashError(null);
    setRemovedIds(ids => withoutId(ids, jobId));
    setReturning(ids => withId(ids, jobId));
    const title = titleOf(jobId);
    const refused = (error: string) => {
      if (reportedElsewhere(`the undo of ${title}`, error)) return;
      setRemovedIds(ids => withId(ids, jobId));
      setReturning(ids => withoutId(ids, jobId));
      setFlashError(error);
    };
    const run = new Promise<boolean>(resolve => startTransition(async () => {
      let saved = false;
      try {
        // A refused decision has already put the row back: there is nothing to undo.
        if (prior && !(await prior)) { setReturning(ids => withoutId(ids, jobId)); return; }
        const result = await decide(jobId, null, "");
        if (!result.ok) { refused(result.error); return; }
        saved = true;
      } catch {
        refused("Could not save. Reload and retry.");
      } finally { settle(jobId, run); resolve(saved); }
    }));
    track(jobId, run);
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
      // A row whose write is still out takes no new decision; its buttons say so too.
      const decidable = row && !inFlight.current.has(row.id) ? row : undefined;
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
          if (decidable) { e.preventDefault(); openReasonBox(decidable.id, "apply", decidable.decision?.decision === "apply" ? decidable.decision.reason : ""); }
          break;
        case "s":
          if (decidable) { e.preventDefault(); openReasonBox(decidable.id, "skip", decidable.decision?.decision === "skip" ? decidable.decision.reason : ""); }
          break;
        default:
          break;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyboard, rows, highlightIndex]);

  // The cursor is followed only when `j` or `k` moves it. Keyed on the rows as well, this ran on
  // every render: a keystroke in a reason box, or a row decided with the mouse further down,
  // scrolled the page back to wherever the cursor had been left (the first row, for a mouse user).
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const followedIndex = useRef(highlightIndex);
  useEffect(() => {
    if (followedIndex.current === highlightIndex) return;
    followedIndex.current = highlightIndex;
    const row = highlightIndex >= 0 ? rowsRef.current[highlightIndex] : undefined;
    if (!row) return;
    document.getElementById(`role-row-${row.id}`)?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

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
                <Button size="sm" variant="ghost" disabled={groupBusy} onClick={() => submitGroupDecision(null, "")}>Undo</Button>
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
              <label className="ds-label" htmlFor="group-reason">Reason for all {selectedIds.length}</label>
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
                placeholder="Why not? (required)"
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
            const busy = writing.has(row.id);
            const detail = details[row.id];
            // The build replaces the link only once its price is in hand: a panel that is still
            // loading, or that could not load, keeps the link rather than offering nothing.
            const buildHere = row.stage === "shortlisted" && detail?.state === "ready";
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
                    <Link prefetch={false} href={`/companies/${row.companyId}`} className="flex items-center gap-1.5 no-underline hover:underline">
                      {/* The same icon the company page shows: the captured logo when there is one,
                          and the browser's own chain behind it. A bare <img> here is why Hims had a
                          logo on its company page and a blank square on its roles. */}
                      <CompanyFavicon src={row.companyLogoUrl ?? row.companyFaviconUrl} domain={row.companyDomain} size={14} />
                      <span className="max-w-[12rem] truncate">{row.companyName}</span>
                    </Link>
                  </TD>}
                  <TD id={`role-row-${row.id}`} className="max-w-[22rem]">
                    <span className="flex flex-wrap items-center gap-2">
                      <button type="button" disabled={reasonBox?.pending} onClick={() => toggleExpanded(row.id)} aria-expanded={expandedId === row.id} className="text-left font-semibold text-fg hover:underline">
                        {row.title}
                      </button>
                      {row.addedByYou && <Badge tone="neutral">Added by you</Badge>}
                      {/* Where a shortlisted role has got to, on the row rather than only inside it. */}
                      {movedOn(row) && <Badge tone={stageTone(row.stage)} title={ROLE_STAGE_DESCRIPTIONS[row.stage]}>{stageLabel(row)}</Badge>}
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
                    {/* A blank score says which of its five causes it is, rather than one dash. */}
                    <FitBar score={row.fitScore} title={fitTitle(row)} state={row.scoreStateText} />
                  </TD>
                  <TD className="text-right">
                    {row.workflowStatus === "user-shortlisted" ? <Link prefetch={false} href={`/applications?job=${row.id}`} className={buttonClass("secondary", "sm", "whitespace-nowrap no-underline")}>{applicationLabel(row)}</Link>
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
                            <h3 className="ds-label mb-1">Why it matched</h3>
                            {row.keywordTerms.length > 0 && (
                              <div className="mb-1 flex flex-wrap gap-1.5">
                                {row.keywordTerms.map(term => <Badge key={term} tone="gray" title="Your keyword">{term}</Badge>)}
                              </div>
                            )}
                            {detail?.state === "ready" && <p className="text-13 text-muted">{detail.details.locationReason}</p>}
                          </div>
                          {(row.fitScore !== null || row.scoreStateText) && (
                            <div>
                              <h3 className="ds-label mb-1">Fit</h3>
                              <div className="flex flex-wrap items-center gap-2">
                                {/* The same words as the cell above, beside the verdict rather than instead of it. */}
                                <FitBar score={row.fitScore} title={fitTitle(row)} state={row.scoreStateText} />
                                {row.fitVerdict && <Badge tone={fitVerdictTone(row.fitVerdict)}>{FIT_VERDICT_LABELS[row.fitVerdict]}</Badge>}
                              </div>
                              {row.fitRationale && <p className="mt-1 max-w-3xl text-14 text-fg">{row.fitRationale}</p>}
                            </div>
                          )}
                          <div>
                            <h3 className="ds-label mb-1">Description</h3>
                            {detail?.state === "loading" && <span className="inline-block text-muted"><Monogram size={16} searching title="Loading the description" /></span>}
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
                              <p className="text-13 text-muted">No description stored. Open the vacancy.</p>
                            ))}
                          </div>
                          {row.events.filter(event => event.label.includes("archiv")).map(event => <p key={event.id} className="text-12 text-muted">{event.label}</p>)}
                          {/* A shortlisted role with no CV yet is built from here; everything else
                              keeps the link to the application that holds its CV. */}
                          {buildHere && detail?.state === "ready" && <BuildCvOffer jobId={row.id} details={detail.details} />}
                          <div className="flex flex-wrap items-center gap-4 text-12">
                            {!buildHere && <Link prefetch={false} href={`/applications?job=${row.id}`} className="font-semibold underline">{applicationLabel(row)}</Link>}
                            <a href={row.url} target="_blank" rel="noopener noreferrer" className="text-muted underline">View vacancy ↗</a>
                            <a href={row.companyHomepageUrl} target="_blank" rel="noopener noreferrer" className="text-muted underline">Website ↗</a>
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
                            disabled={boxed.pending || busy} onClick={() => setReasonBox({ ...boxed, kind: "apply" })}
                          >
                            Shortlist
                          </Button>
                          <Button
                            size="sm"
                            variant={boxed.kind === "skip" ? "primary" : "secondary"}
                            aria-pressed={boxed.kind === "skip"}
                            disabled={boxed.pending || busy} onClick={() => setReasonBox({ ...boxed, kind: "skip" })}
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
                              if (!boxed.pending && !busy) void submitDecision(row.id, boxed.kind, boxed.text);
                            }
                          }}
                          placeholder={boxed.kind === "skip" ? "Why not? (required)" : APPLY_REASON_HINT}
                          rows={boxed.kind === "skip" ? 2 : 1}
                          className="w-full resize-y border-2 border-line-muted bg-bg px-2 py-1 font-mono text-12 text-fg placeholder:text-faint focus:border-line focus:outline-none"
                        />
                        {boxed.error && <p className="text-12 text-danger">{boxed.error}</p>}
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={boxed.pending || busy}
                            onClick={() => void submitDecision(row.id, boxed.kind, boxed.text)}
                          >
                            {boxed.pending || busy ? "Saving…" : "Save"}
                          </Button>
                          <Button size="sm" variant="ghost" disabled={boxed.pending} onClick={() => setReasonBox(null)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : row.decision ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={decisionTone(row.decision.decision)}>{ROLE_STATUS_LABELS[row.decision.decision === "apply" ? "user-shortlisted" : "user-dismissed"]}</Badge>
                        {movedOn(row) && <Badge tone={stageTone(row.stage)} title={ROLE_STAGE_DESCRIPTIONS[row.stage]}>{stageLabel(row)}</Badge>}
                        <span className="text-12 text-muted" title={row.decision.createdTitle}>Decided {row.decision.createdLabel}</span>
                        {row.decision.reason && <p className="w-full text-14 text-fg">{row.decision.reason}</p>}
                        <button type="button" disabled={busy} onClick={() => openReasonBox(row.id, row.decision!.decision, row.decision!.reason)} className="text-12 text-muted underline hover:text-fg disabled:opacity-40">
                          Reconsider
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            void submitDecision(row.id, null, "");
                          }}
                          className="text-12 text-muted underline hover:text-fg disabled:opacity-40"
                        >
                          Reset
                        </button>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <Button size="sm" variant="primary" disabled={busy} onClick={() => void submitDecision(row.id, "apply", "")}>
                          {busy ? "Saving…" : "Shortlist"}
                        </Button>
                        <Button size="sm" disabled={busy} onClick={() => openReasonBox(row.id, "skip")}>
                          Dismiss
                        </Button>
                      </div>
                    )}
                    <button type="button" disabled={archivingId !== null || reasonBox?.pending || busy} onClick={() => void archiveRow(row.id)} className="mt-2 text-12 text-muted underline disabled:opacity-40">{archivingId === row.id ? "Saving…" : archived ? "Restore" : "Archive"}</button>
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
