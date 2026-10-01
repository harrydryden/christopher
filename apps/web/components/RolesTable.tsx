"use client";

import { memo, startTransition, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { decideWithUndoToken, decideRolesWithUndoTokens, undoDecisionIfCurrent, undoDecisionsIfCurrent, archiveRoles, roleDetails } from "@/app/actions/decisions";
import { requestCv } from "@/app/actions/cv";
import { Badge, decisionTone, fitVerdictTone, stageTone, FIT_VERDICT_LABELS } from "@/components/Badge";
import { CompanyFavicon } from "@/components/CompanyFavicon";
import { FitBar, Table, TBody, TD, TH, THead, TR } from "@/components/table";
import { Button, buttonClass } from "@/components/Button";
import { Monogram } from "@/components/brand/Monogram";
import { SafeMarkdown } from "@/components/SafeMarkdown";
import { SettingsForm } from "@/components/SettingsForm";
import { RetryScore } from "@/components/RetryScore";
import type { RoleCompaniesVM, RoleCompanyVM, RoleDetailsVM, RoleRowVM, SortDir, SortKey } from "@/lib/queries/jobs";
import { missingDecisionReason } from "@/lib/decision-reason";
import { reportRoleRefusal } from "@/lib/role-refusals";
import { claimRoleRevision, discardLegacyRoleUndos, forgetRoleUndo, hasLegacyRoleUndos, isCurrentRoleRevision, recentRoleUndos, rememberRoleUndo, ROLE_UNDO_CHANGED, type RoleUndoEntry } from "./role-undo-history";
import styles from "./RolesTable.module.css";

import { APPLICATION_STATUS_LABELS, ROLE_STAGE_DESCRIPTIONS, ROLE_STAGE_LABELS, ROLE_STATUS_LABELS, roleStageRank } from "@ava/core/role-workflow";

type ReasonKind = "apply" | "skip";

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

/** What a row's live-for figure counts from, for its `title`: the server sends only which basis. */
function liveForTitle(row: RoleRowVM): string {
  const counted = row.liveForBasis === "first_seen"
    ? "Counted from when this tool first saw the role; the source publishes no posted date."
    : "Counted from the date the source published for this role.";
  return row.seeded ? `${counted} (seeded on first scan)` : counted;
}

/** Drawn for a company the page's map does not hold: a blank icon and no website link. */
const unknownCompany: RoleCompanyVM = { iconSrc: null, domain: "", homepageUrl: "" };

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

/**
 * The reason box as the table holds it: which row, which way, and whether it is being saved. The
 * text is not here: `ReasonBox` owns it, so a keystroke renders the box and nothing else. `prefill`
 * is what the box opens with, and `opened` tells one opening from the next, so a box opened again
 * (or put back after a refusal, with the text that was sent) starts from its own `prefill`.
 */
interface ReasonBoxState {
  jobId: string;
  kind: ReasonKind;
  prefill: string;
  pending: boolean;
  error: string | null;
  opened: number;
  /** Take the focus when it opens: yes when a person opened it, no when a refusal put it back. */
  focus: boolean;
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

/**
 * What a row can ask the table to do. One object for the table's lifetime whose methods call the
 * table's current handlers through a ref, so a memoised row never holds a stale handler and never
 * re-renders because a handler was re-created.
 */
interface RowActions {
  toggleExpanded(jobId: string): void;
  toggleSelected(jobId: string): void;
  openReasonBox(jobId: string, kind: ReasonKind, prefill?: string): void;
  submitDecision(jobId: string, decision: ReasonKind | null, reason: string): void;
  archiveRow(jobId: string): void;
  setBoxKind(jobId: string, kind: ReasonKind): void;
  closeBox(): void;
  toggleDescription(): void;
}

/**
 * The reason box for one row: it owns what is typed, so typing renders only this box. Enter saves
 * (R-7.2) with the text in hand; Shift+Enter is a new line; Escape closes.
 */
function ReasonBox({ jobId, title, companyName, box, busy, actions }: { jobId: string; title: string; companyName: string; box: ReasonBoxState; busy: boolean; actions: RowActions }) {
  const [text, setText] = useState(box.prefill);
  const field = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { if (box.focus) field.current?.focus(); }, [box.focus]);
  const save = () => { if (!box.pending && !busy) actions.submitDecision(jobId, box.kind, text); };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Button size="sm" variant={box.kind === "apply" ? "primary" : "secondary"} aria-pressed={box.kind === "apply"}
          disabled={box.pending || busy} onClick={() => actions.setBoxKind(jobId, "apply")}>
          Shortlist
        </Button>
        <Button size="sm" variant={box.kind === "skip" ? "primary" : "secondary"} aria-pressed={box.kind === "skip"}
          disabled={box.pending || busy} onClick={() => actions.setBoxKind(jobId, "skip")}>
          Dismiss
        </Button>
      </div>
      {box.kind === "skip" && <div className="flex flex-wrap gap-2">
        {["Wrong location", "Wrong seniority", "Not interested"].map(reason => <Button key={reason} size="sm" variant="ghost" disabled={box.pending}
          onClick={() => setText(reason)}>{reason}</Button>)}
      </div>}
      <label htmlFor={`role-reason-${jobId}`} className="text-13 font-semibold text-fg">
        {box.kind === "skip" ? "Why dismiss" : "Why shortlist"} {title} at {companyName}{box.kind === "skip" ? "?" : "? (optional)"}
      </label>
      <textarea id={`role-reason-${jobId}`} disabled={box.pending}
        ref={field}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            actions.closeBox();
            e.currentTarget.blur();
          } else if (e.key === "Enter" && !e.shiftKey) {
            // R-7.2: enter saves. Shift+Enter is still a new line, and an empty
            // box on a shortlist saves the decision without a reason.
            e.preventDefault();
            save();
          }
        }}
        placeholder={box.kind === "skip" ? "Why not? (required)" : APPLY_REASON_HINT}
        rows={box.kind === "skip" ? 2 : 1}
        className="w-full resize-y border-2 border-line-muted bg-bg px-2 py-1 font-mono text-12 text-fg placeholder:text-faint focus:border-line focus:outline-none"
      />
      {box.error && <p className="text-12 text-danger">{box.error}</p>}
      <div className="flex gap-2">
        <Button size="sm" variant="primary" disabled={box.pending || busy} onClick={save}>
          {box.pending || busy ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" disabled={box.pending} onClick={() => actions.closeBox()}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

interface RoleRowProps {
  row: RoleRowVM;
  company: RoleCompanyVM;
  highlighted: boolean;
  selected: boolean;
  /** A write for this row is out: its actions wait. */
  busy: boolean;
  expanded: boolean;
  detail: DetailState | undefined;
  /** This row's reason box, or null when the box (if any) is another row's. */
  boxed: ReasonBoxState | null;
  /** The open panel's description is expanded; always false for a closed row. */
  descriptionOpen: boolean;
  hideCompany: boolean;
  archived: boolean;
  groupBusy: boolean;
  /** Some row's reason box is being saved: every row's actions wait. */
  boxPending: boolean;
  archivingThis: boolean;
  archivingAny: boolean;
  actions: RowActions;
}

/**
 * One role: its line in the table and, when open, its review panel. Memoised on primitives and
 * stable references, so a keystroke, a `j`/`k` press or a selection renders only the rows it changes.
 */
const RoleRow = memo(function RoleRow({ row, company, highlighted, selected, busy, expanded, detail, boxed, descriptionOpen, hideCompany, archived, groupBusy, boxPending, archivingThis, archivingAny, actions }: RoleRowProps) {
  // The build replaces the link only once its price is in hand: a panel that is still
  // loading, or that could not load, keeps the link rather than offering nothing.
  const buildHere = row.stage === "shortlisted" && detail?.state === "ready";
  return (
    <>
      <TR highlighted={highlighted} className={`${styles.roleRow} ${selected ? "bg-sunken" : ""}`}>
        <TD className={styles.roleSelect}>
          <label className="inline-flex min-h-11 min-w-11 items-center">
            <input
            type="checkbox"
            className="h-4 w-4 m-0 mt-0.5 align-middle"
            aria-label={`Select ${row.title}${hideCompany ? "" : ` at ${row.companyName}`}`}
            aria-checked={selected}
            checked={selected}
            disabled={groupBusy}
            onChange={() => actions.toggleSelected(row.id)}
            />
          </label>
        </TD>
        {!hideCompany && <TD className={styles.roleCompany}>
          <Link prefetch={false} href={`/companies/${row.companyId}`} className="flex items-center gap-1.5 no-underline hover:underline">
            {/* The same icon the company page shows: the captured logo when there is one,
                and the browser's own chain behind it. A bare <img> here is why Hims had a
                logo on its company page and a blank square on its roles. */}
            <CompanyFavicon src={company.iconSrc} domain={company.domain} size={14} />
            <span className="max-w-[12rem] truncate">{row.companyName}</span>
          </Link>
        </TD>}
        <TD id={`role-row-${row.id}`} className={`${styles.roleTitle} max-w-[22rem]`}>
          <span className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={boxPending} onClick={() => actions.toggleExpanded(row.id)} aria-expanded={expanded} className="text-left font-semibold text-fg hover:underline">
              {row.title}
            </button>
            {row.addedByYou && <Badge tone="neutral">Added by you</Badge>}
            {/* Where a shortlisted role has got to, on the row rather than only inside it. */}
            {movedOn(row) && <Badge tone={stageTone(row.stage)} title={ROLE_STAGE_DESCRIPTIONS[row.stage]}>{stageLabel(row)}</Badge>}
          </span>
          <p className="mt-1 text-12 text-muted"><span title={liveForTitle(row)}>{row.liveForText}</span>{row.status === "closed" && <span className="ml-2 text-warn">Vacancy closed</span>}</p>
        </TD>
        <TD className={`${styles.roleLocation} max-w-[10rem]`}>
          <span className="md:hidden text-muted">Location: </span>
          <div className="flex flex-wrap items-center gap-1">
            {row.locations.length > 3 ? (
              <details>
                <summary className="cursor-pointer">{row.locations[0]} + {row.locations.length - 1} more locations</summary>
                <ul className="mt-2 space-y-1 text-12 [overflow-wrap:anywhere]">
                  {row.locations.map((location, index) => <li key={`${location}-${index}`}>{location}</li>)}
                </ul>
              </details>
            ) : <span>{row.locations.length ? row.locations.join(", ") : row.location}</span>}
            {row.remote && <Badge tone="blue">Remote</Badge>}
            {!row.location && row.locations.length === 0 && !row.remote && <span className="text-muted">—</span>}
          </div>
        </TD>
        <TD className={`${styles.roleFit} whitespace-nowrap`}>
          <span className="block md:hidden text-muted">Fit: </span>
          {/* A missing or previous score carries its current update status. */}
          <FitBar score={row.fitScore} title={fitTitle(row)} state={row.scoreStateText} />
        </TD>
        <TD className={`${styles.roleAction} text-right`}>
          {row.workflowStatus === "user-shortlisted" ? <Link prefetch={false} href={`/applications?job=${row.id}`} className={buttonClass("secondary", "sm", "whitespace-nowrap no-underline")}>{applicationLabel(row)}</Link>
          : archived ? <Button size="sm" disabled={archivingAny || boxPending} onClick={() => actions.archiveRow(row.id)}>{archivingThis ? "Restoring…" : "Restore"}</Button>
          : <Button
            size="sm"
            aria-expanded={expanded}
            aria-controls={`role-review-${row.id}`}
            aria-label={`${expanded ? "Close review for" : "Review"} ${row.title} at ${row.companyName}`}
            disabled={boxPending}
            onClick={() => actions.toggleExpanded(row.id)}
          >
            {expanded ? "Close" : row.workflowStatus === "user-dismissed" ? "Reconsider" : "Review"}
          </Button>}
        </TD>
      </TR>
      {expanded && (
        <tr id={`role-review-${row.id}`} className={`${styles.reviewRow} bg-sunken`}>
          <td colSpan={hideCompany ? 5 : 6} className="p-4">
            <div className={`${styles.reviewBody} grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(256px,352px)]`}>
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
                    {(row.scoreState === "failed" || row.scoreState === "requested" || row.scoreState === "queued") && !archived && <RetryScore jobId={row.id} scoreState={row.scoreState} />}
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
                        <button type="button" onClick={() => actions.toggleDescription()} className="mt-1 text-12 text-muted underline hover:text-fg">
                          {descriptionOpen ? "Show less" : "Show more"}
                        </button>
                      )}
                    </>
                  ) : (
                    <p className="text-13 text-muted">No description stored. Open the vacancy.</p>
                  ))}
                </div>
                {detail?.state === "ready" && detail.details.archiveNotes.map((note, i) => <p key={i} className="text-12 text-muted">{note}</p>)}
                {/* A shortlisted role with no CV yet is built from here; everything else
                    keeps the link to the application that holds its CV. */}
                {buildHere && detail?.state === "ready" && <BuildCvOffer jobId={row.id} details={detail.details} />}
                <div className="flex flex-wrap items-center gap-4 text-12">
                  {!buildHere && <Link prefetch={false} href={`/applications?job=${row.id}`} className="font-semibold underline">{applicationLabel(row)}</Link>}
                  <a href={row.url} target="_blank" rel="noopener noreferrer" className="text-muted underline">View vacancy ↗</a>
                  {company.homepageUrl && <a href={company.homepageUrl} target="_blank" rel="noopener noreferrer" className="text-muted underline">Website ↗</a>}
                </div>
              </div>
              <div className="space-y-3">
                <p className="text-14 font-semibold text-fg">{row.title}<span className="block text-13 font-normal text-muted">{row.companyName}</span></p>
                <h3 className="ds-label">{ROLE_STATUS_LABELS[row.workflowStatus]}</h3>
                {boxed ? (
                  <ReasonBox key={boxed.opened} jobId={row.id} title={row.title} companyName={row.companyName} box={boxed} busy={busy} actions={actions} />
                ) : row.decision ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={decisionTone(row.decision.decision)}>{ROLE_STATUS_LABELS[row.decision.decision === "apply" ? "user-shortlisted" : "user-dismissed"]}</Badge>
                    {movedOn(row) && <Badge tone={stageTone(row.stage)} title={ROLE_STAGE_DESCRIPTIONS[row.stage]}>{stageLabel(row)}</Badge>}
                    <span className="text-12 text-muted" title={row.decision.createdTitle}>Decided {row.decision.createdLabel}</span>
                    {row.decision.reason && <p className="w-full text-14 text-fg">{row.decision.reason}</p>}
                    <button type="button" disabled={busy} onClick={() => actions.openReasonBox(row.id, row.decision!.decision, row.decision!.reason)} className="text-12 text-muted underline hover:text-fg disabled:opacity-40">
                      Reconsider
                    </button>
                    <button type="button" disabled={busy} onClick={() => actions.submitDecision(row.id, null, "")} className="text-12 text-muted underline hover:text-fg disabled:opacity-40">
                      Reset
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <Button size="sm" variant="primary" disabled={busy} onClick={() => actions.submitDecision(row.id, "apply", "")}>
                      {busy ? "Saving…" : "Shortlist"}
                    </Button>
                    <Button size="sm" disabled={busy} onClick={() => actions.openReasonBox(row.id, "skip")}>
                      Dismiss
                    </Button>
                  </div>
                )}
                <button type="button" disabled={archivingAny || boxPending || busy} onClick={() => actions.archiveRow(row.id)} className="mt-2 text-12 text-muted underline disabled:opacity-40">{archivingThis ? "Saving…" : archived ? "Restore" : "Archive"}</button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
});

export function RolesTable({ rows: inputRows, companies, hideCompany = false, keyboard = false, archived = false, emptyState, sortLinks, sort, dir, historyScope }: {
  hideCompany?: boolean; archived?: boolean; rows: RoleRowVM[]; keyboard?: boolean; emptyState: React.ReactNode;
  /** Account id; recent Undo survives the keyed table's filters and pages within this browser tab. */
  historyScope?: string;
  /** The rows' companies, once each (`buildRoleCompanies` over the same rows). */
  companies: RoleCompaniesVM;
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
  const departed = useRef(new Map<string, { row: RoleRowVM; index: number; company: RoleCompanyVM }>());
  /**
   * A row's company, from this page's map; a row an undo brought back after the page changed is
   * drawn with the company it left with, so it never comes back with a blank icon.
   */
  const companyOf = (row: RoleRowVM): RoleCompanyVM => companies[row.companyId] ?? departed.current.get(row.id)?.company ?? unknownCompany;
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
    // Keep a row while its recent Undo is available, so it can return instantly on this page.
    const undoable = new Set((historyScope ? recentRoleUndos(historyScope) : recentUndos).map(entry => entry.jobId));
    for (const id of departed.current.keys()) {
      if (id !== noticeRef.current?.jobId && !undoable.has(id) && !inFlight.current.has(id) && !returningRef.current.has(id)) departed.current.delete(id);
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

  /**
   * One write for one row, in a transition: `body` answers whether it saved, and a throw is refused
   * with the generic sentence. The write is tracked until it settles, so an undo can queue behind it
   * (`inFlight.current.get(id) !== run`) and see whether it saved.
   */
  function rowWrite(id: string, body: () => Promise<boolean>, refused: (error: string) => void) {
    const run = new Promise<boolean>(resolve => startTransition(async () => {
      let saved = false;
      try {
        saved = await body();
      } catch {
        refused("Could not save. Reload and retry.");
      } finally { settle(id, run); resolve(saved); }
    }));
    track(id, run);
  }

  const [archivingId, setArchivingId] = useState<string | null>(null);
  function archiveRow(id: string) {
    if (inFlight.current.has(id)) return;
    const title = titleOf(id);
    rowWrite(id, async () => {
      setArchivingId(id); setFlashError(null);
      try {
        const result = await archiveRoles([id], !archived);
        if (!result.ok) { if (!reportedElsewhere(title, result.error)) setFlashError(result.error); return false; }
        setRemovedIds(ids => withId(ids, id));
        return true;
      } finally { setArchivingId(null); }
    }, (error) => { if (!reportedElsewhere(title, error)) setFlashError(error); });
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
  function runGroup(label: string, run: () => Promise<{ ok: true; message?: string } | { ok: false; error: string }>, leaving: (row: RoleRowVM) => boolean, onSaved?: (ids: string[]) => void) {
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
        else onSaved?.(ids);
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
    const selectedRows = rows.filter(row => ids.includes(row.id));
    if (decision === null && selectedRows.some(row => !row.decision?.id)) {
      setGroupError("Select only roles with decisions to undo. Reload roles if a decision changed.");
      return;
    }
    const expected = decision === null ? selectedRows.map(row => ({ jobId: row.id, decisionId: row.decision!.id })) : [];
    const labelled = selectedRows.map(row => ({ id: row.id, text: decision ? decidedText(row, decision) : "" }));
    let tokens: Record<string, string> = {};
    runGroup(decision === null ? "Undoing…" : "Saving…", async () => {
      if (decision === null) return undoDecisionsIfCurrent(expected);
      const result = await decideRolesWithUndoTokens(ids, decision, reason);
      if (result.ok) tokens = result.decisionIds;
      return result;
    },
      row => archived || (row.decision?.decision ?? null) !== decision,
      () => {
        if (!historyScope) return;
        for (const item of labelled) {
          if (decision === null) forgetRoleUndo(historyScope, item.id);
          else if (tokens[item.id]) rememberRoleUndo(historyScope, { jobId: item.id, text: item.text, decisionId: tokens[item.id], revision: claimRoleRevision(historyScope, item.id) });
        }
      });
  }

  // The cursor starts on the first row rather than nowhere, so the first `a` or `s` acts on
  // something and the shortcuts under the table are about a row the reader can see.
  const [highlightIndex, setHighlightIndex] = useState(keyboard && inputRows.length > 0 ? 0 : -1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, DetailState>>({});
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const [reasonBox, setReasonBox] = useState<ReasonBoxState | null>(null);
  const [flashError, setFlashError] = useState<string | null>(null);
  const [notice, setNotice] = useState<RoleUndoEntry | null>(null);
  const [recentUndos, setRecentUndos] = useState<RoleUndoEntry[]>([]);
  const [legacyUndo, setLegacyUndo] = useState(false);
  const [undoingIds, setUndoingIds] = useState<ReadonlySet<string>>(() => new Set());
  const savedDecisionIds = useRef(new Map<string, string>());
  const noticeRef = useRef(notice);
  noticeRef.current = notice;
  const reasonBoxRef = useRef(reasonBox);
  reasonBoxRef.current = reasonBox;
  /** Tells one opening of a reason box from the next, so a re-opened box starts from its prefill. */
  const boxOpenings = useRef(0);

  useEffect(() => {
    if (!historyScope) return;
    const refresh = () => {
      setRecentUndos(recentRoleUndos(historyScope));
      setLegacyUndo(hasLegacyRoleUndos(historyScope));
    };
    refresh();
    window.addEventListener(ROLE_UNDO_CHANGED, refresh);
    return () => window.removeEventListener(ROLE_UNDO_CHANGED, refresh);
  }, [historyScope]);

  function showNotice(jobId: string, text: string): RoleUndoEntry {
    const entry = { jobId, text, revision: historyScope ? claimRoleRevision(historyScope, jobId) : (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`) };
    setNotice(entry);
    return entry;
  }
  function clearNotice(jobId?: string) {
    setNotice(current => !jobId || current?.jobId === jobId ? null : current);
  }

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
    setReasonBox({ jobId, kind, prefill, pending: false, error: null, opened: ++boxOpenings.current, focus: true });
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
    if (decision === null && !previous?.decision?.id) {
      setFlashError("This decision changed. Reload roles before resetting it.");
      return;
    }
    const leaves = archived || previous?.decision?.decision !== decision;
    const previousUndo = historyScope ? recentRoleUndos(historyScope).find(entry => entry.jobId === jobId) : undefined;
    let decisionNotice: RoleUndoEntry | null = null;

    if (leaves) {
      if (previous) departed.current.set(jobId, { row: previous, index, company: companyOf(previous) });
      setRemovedIds(ids => withId(ids, jobId));
      setReturning(ids => withoutId(ids, jobId));
      if (box) setReasonBox(null);
      if (decision !== null && previous) decisionNotice = showNotice(jobId, decidedText(previous, decision));
    } else if (box) {
      // Re-saving the decision the row already has (a new reason): the row stays, so the box waits.
      setReasonBox(b => (b ? { ...b, pending: true, error: null } : b));
    }

    const title = previous?.title ?? "this role";
    const refused = (error: string) => {
      // The old decision still stands. Restore its Undo even if this table was replaced while
      // the attempted re-decision was in flight.
      if (previousUndo && historyScope && decisionNotice && isCurrentRoleRevision(historyScope, decisionNotice))
        rememberRoleUndo(historyScope, { ...previousUndo, revision: claimRoleRevision(historyScope, jobId) });
      if (reportedElsewhere(title, error)) return;
      if (leaves) {
        setRemovedIds(ids => withoutId(ids, jobId));
        if (noticeRef.current?.jobId === jobId) clearNotice(jobId);
      }
      if (box && !leaves) setReasonBox(b => (b?.jobId === jobId ? { ...b, pending: false, error } : b));
      else if (box && reasonBoxRef.current === null) {
        // Back where it was typed, unless another row's box has been opened since.
        setExpandedId(jobId);
        // With the text that was sent: the box that held it left with the row.
        setReasonBox({ ...box, prefill: reason, pending: false, error, opened: ++boxOpenings.current, focus: false });
      } else setFlashError(error);
    };

    rowWrite(jobId, async () => {
      const result = decision !== null
        ? await decideWithUndoToken(jobId, decision, reason)
        : await undoDecisionIfCurrent(jobId, previous!.decision!.id);
      if (!result.ok) { refused(result.error); return false; }
      if ("decisionId" in result && typeof result.decisionId === "string") savedDecisionIds.current.set(jobId, result.decisionId);
      if (!leaves) {
        if (box) setReasonBox(b => (b?.jobId === jobId ? null : b));
        if (decision !== null && previous) decisionNotice = showNotice(jobId, decidedText(previous, decision));
      }
      if (decision === null) {
        clearNotice(jobId);
        if (historyScope) forgetRoleUndo(historyScope, jobId);
        else setRecentUndos(entries => entries.filter(entry => entry.jobId !== jobId));
      } else if (decisionNotice) {
        if (historyScope) {
          const decisionId = savedDecisionIds.current.get(jobId);
          if (decisionId) rememberRoleUndo(historyScope, { ...decisionNotice, decisionId });
          else setFlashError("Saved, but Undo is unavailable until you reload roles.");
        }
        else setRecentUndos(entries => [decisionNotice!, ...entries.filter(entry => entry.jobId !== jobId)].slice(0, 5));
        clearNotice(jobId);
      }
      return true;
    }, refused);
  }

  /**
   * The notice's way back: the row returns at once and the decision is undone. Pressed while the
   * decision is still being saved, the undo waits for it, and has nothing to do if it was refused.
   */
  function undoDecision(jobId: string, entry?: RoleUndoEntry) {
    if (entry && historyScope && !isCurrentRoleRevision(historyScope, entry)) {
      forgetRoleUndo(historyScope, jobId);
      return;
    }
    if (undoingIds.has(jobId)) return;
    const prior = inFlight.current.get(jobId);
    const wasRemoved = removedIds.has(jobId);
    const wasReturning = returning.has(jobId);
    clearNotice(jobId);
    setUndoingIds(ids => withId(ids, jobId));
    setFlashError(null);
    setRemovedIds(ids => withoutId(ids, jobId));
    setReturning(ids => withId(ids, jobId));
    const title = titleOf(jobId);
    const refused = (error: string) => {
      if (reportedElsewhere(`the undo of ${title}`, error)) return;
      setRemovedIds(ids => wasRemoved ? withId(ids, jobId) : withoutId(ids, jobId));
      setReturning(ids => wasReturning ? withId(ids, jobId) : withoutId(ids, jobId));
      setFlashError(`Could not undo ${title}: ${error}`);
      setUndoingIds(ids => withoutId(ids, jobId));
    };
    rowWrite(jobId, async () => {
      // A refused decision has already put the row back: there is nothing to undo.
      if (prior && !(await prior)) {
        setReturning(ids => withoutId(ids, jobId));
        setUndoingIds(ids => withoutId(ids, jobId));
        if (historyScope) forgetRoleUndo(historyScope, jobId);
        else setRecentUndos(entries => entries.filter(entry => entry.jobId !== jobId));
        return false;
      }
      if (entry && historyScope && !isCurrentRoleRevision(historyScope, entry)) {
        setUndoingIds(ids => withoutId(ids, jobId));
        setReturning(ids => withoutId(ids, jobId));
        return false;
      }
      const expectedDecisionId = entry?.decisionId ?? savedDecisionIds.current.get(jobId);
      if (!expectedDecisionId) {
        refused("This Undo has no decision token. Reload roles to review the latest decision.");
        return false;
      }
      const result = await undoDecisionIfCurrent(jobId, expectedDecisionId);
      if (!result.ok) { refused(result.error); return false; }
      if (historyScope) forgetRoleUndo(historyScope, jobId);
      else setRecentUndos(entries => entries.filter(entry => entry.jobId !== jobId));
      setUndoingIds(ids => withoutId(ids, jobId));
      return true;
    }, refused);
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

  // Every handler a row calls, read through a ref when it is called — so it is always this render's,
  // closing over this render's rows — behind one object that never changes, so passing it to 50
  // memoised rows costs none of them a render.
  const handlers = useRef({ toggleExpanded, toggleSelected, openReasonBox, submitDecision, archiveRow });
  handlers.current = { toggleExpanded, toggleSelected, openReasonBox, submitDecision, archiveRow };
  const rowActions = useMemo<RowActions>(() => ({
    toggleExpanded: (jobId) => handlers.current.toggleExpanded(jobId),
    toggleSelected: (jobId) => handlers.current.toggleSelected(jobId),
    openReasonBox: (jobId, kind, prefill) => handlers.current.openReasonBox(jobId, kind, prefill),
    submitDecision: (jobId, decision, reason) => handlers.current.submitDecision(jobId, decision, reason),
    archiveRow: (jobId) => handlers.current.archiveRow(jobId),
    setBoxKind: (jobId, kind) => setReasonBox(box => (box?.jobId === jobId ? { ...box, kind } : box)),
    closeBox: () => setReasonBox(null),
    toggleDescription: () => setDescriptionOpen(open => !open),
  }), []);

  const history = keyboard ? recentUndos.filter(entry => entry.jobId !== notice?.jobId) : [];
  const undoNotice = (notice || history.length > 0 || (keyboard && legacyUndo)) && (
    <section aria-label="Recent decisions" className="mt-3 border-2 border-line-muted px-3 py-2 text-13 text-fg">
      <h3 className="font-semibold">Recent decisions · Undo</h3>
      {keyboard && legacyUndo && <p className="mt-1 text-13 text-warn">
        Older Undo entries cannot be checked against the latest decision.{" "}
        <button type="button" className="min-h-11 font-semibold underline" onClick={() => {
          if (historyScope) discardLegacyRoleUndos(historyScope);
          window.location.reload();
        }}>Reload roles</button>
      </p>}
      <ul className="mt-1 space-y-1">
        {notice && <li role="status" aria-live="polite" className="flex flex-wrap items-center justify-between gap-2">
          <span>{notice.text}{undoingIds.has(notice.jobId) ? " · Undoing…" : " · Saving…"}</span>
          <button type="button" disabled={undoingIds.has(notice.jobId)} onClick={() => undoDecision(notice.jobId, notice)}
            className="min-h-11 text-13 font-semibold underline hover:text-muted">Undo</button>
        </li>}
        {history.map(entry => <li key={entry.jobId} className="flex flex-wrap items-center justify-between gap-2">
          <span>{entry.text}</span>
          <button type="button" disabled={undoingIds.has(entry.jobId)} onClick={() => undoDecision(entry.jobId, entry)}
            aria-label={`Undo ${entry.text}`} className="min-h-11 text-13 font-semibold underline hover:text-muted">
            {undoingIds.has(entry.jobId) ? "Undoing…" : "Undo"}
          </button>
        </li>)}
      </ul>
    </section>
  );
  const errorNotice = flashError && <p role="alert" className="mb-2 border-2 border-danger px-3 py-1.5 text-14 text-danger">{flashError}</p>;

  if (rows.length === 0) return <div>{errorNotice}{emptyState}{undoNotice}</div>;

  return (
    <div className={styles.cards}>
      {errorNotice}
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
            <TH>Action</TH>
          </tr>
        </THead>
        <TBody>
          {rows.map((row, index) => {
            const expanded = expandedId === row.id;
            return (
              <RoleRow
                key={row.id}
                row={row}
                company={companyOf(row)}
                highlighted={index === highlightIndex}
                selected={selected.has(row.id)}
                busy={writing.has(row.id)}
                expanded={expanded}
                detail={details[row.id]}
                boxed={reasonBox?.jobId === row.id ? reasonBox : null}
                descriptionOpen={expanded && descriptionOpen}
                hideCompany={hideCompany}
                archived={archived}
                groupBusy={groupBusy}
                boxPending={!!reasonBox?.pending}
                archivingThis={archivingId === row.id}
                archivingAny={archivingId !== null}
                actions={rowActions}
              />
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
