"use client";

import { Fragment, Suspense, use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  APPLICATION_STATUSES,
  APPLICATION_STATUS_LABELS,
  ROLE_STAGE_LABELS,
  applicationStage,
  roleStageRank,
  type ApplicationStatus,
} from "@ava/core/role-workflow";
import { Badge, stageTone } from "@/components/Badge";
import { Button } from "@/components/Button";
import { MarkSmall } from "@/components/brand";
import { CompanyFavicon } from "@/components/CompanyFavicon";
import { inputClass, labelClass, selectClass } from "@/components/Field";
import { SettingsForm } from "@/components/SettingsForm";
import { Table, TBody, TD, TH, THead, TR } from "@/components/table";
import { manageRoleCv, setRoleStage, updateApplication } from "@/app/actions/applications";
import { requestCv } from "@/app/actions/cv";
import { historyLine, type NextStepNote } from "@/lib/application-dates";
import { relativeTime } from "@/lib/format";
import type { PipelineCvQuote, PipelineRow } from "@/lib/queries/applications";

/**
 * Credit availability per posting. The page streams it after the table's rows are read.
 */
export type PipelineCvQuotes = Record<string, PipelineCvQuote>;
type QuoteSource = PipelineCvQuotes | Promise<PipelineCvQuotes>;
/** A promise that crossed from the server arrives as React's own thenable, so it is tested by shape. */
const isThenable = (value: QuoteSource): value is Promise<PipelineCvQuotes> => typeof (value as { then?: unknown }).then === "function";

/** The one sentence the product uses for work an unconfirmed account cannot start. */
import { VERIFY_SENTENCE as UNVERIFIED } from "@/components/VerifyNotice";
import { useActionCall } from "@/components/useActionCall";


/** "In process · Interview": the stage, and — for the three steps it collapses — which one. */
function stageLabel(row: PipelineRow): string {
  const label = ROLE_STAGE_LABELS[row.stage];
  return row.stage === "in_process" && row.application
    ? `${label} · ${APPLICATION_STATUS_LABELS[row.application.status]}`
    : label;
}

/** What the CV column says, before the archived-predecessor note is added to it. */
function cvLabel(row: PipelineRow): string {
  if (!row.cv) return "—";
  switch (row.cv.status) {
    case "queued": return "Queued";
    case "generating": return row.cv.progress ? `Building · ${row.cv.progress}` : "Building…";
    case "awaiting_evidence": return "Waiting for your evidence";
    case "failed": return "Failed";
    case "ready": return `Ready · V${Math.max(1, row.cv.revision)}${row.cv.finalisedAt ? " · finalised" : ""}`;
  }
}

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** The status control writes through the role when there is one, and by row id when there is not. */
function statusAction(row: PipelineRow) {
  if (row.jobId) return setRoleStage.bind(null, row.jobId);
  if (row.application) return updateApplication.bind(null, row.application.id);
  return null;
}

function StatusPanel({ row }: { row: PipelineRow }) {
  const action = statusAction(row);
  const current = row.application?.status ?? null;
  const [status, setStatus] = useState<ApplicationStatus>(current ?? "applying");
  const [appliedOnValue, setAppliedOnValue] = useState(row.application?.appliedOn ?? "");
  const [appliedOnEdited, setAppliedOnEdited] = useState(false);
  const history = [...(row.application?.history ?? [])].reverse();
  // A row with no posting behind it is keyed by its company and role, which carries spaces; an
  // element id may not.
  const formId = `application-status-${row.key.replace(/\s+/g, "-")}`;
  const confirmField = useRef<HTMLInputElement | null>(null);
  /**
   * A status that ranks below the one on record rewrites what the row says happened, so the row
   * asks before it submits and sends the answer with the form. The action checks for it too: this
   * is the question, not the guard.
   *
   * The listener is the form element's own rather than a React `onSubmit`, because React handles
   * form actions from a listener on the root and a native listener on the form runs first —
   * `stopPropagation` is therefore the one thing that can stop the action from running.
   */
  const backwards =
    current && roleStageRank(applicationStage(status)) < roleStageRank(applicationStage(current))
      ? `Move this application from ${APPLICATION_STATUS_LABELS[current]} back to ${APPLICATION_STATUS_LABELS[status]}?`
      : null;
  // Applied is dated by the application date and Applying has nothing to date; every other status
  // is about a day of its own.
  const datesTheEntry = status !== "applying" && status !== "applied";
  useEffect(() => {
    const form = document.getElementById(formId);
    if (!(form instanceof HTMLFormElement)) return;
    const ask = (event: SubmitEvent) => {
      if (confirmField.current) confirmField.current.value = "";
      if (!backwards) return;
      if (window.confirm(backwards)) {
        if (confirmField.current) confirmField.current.value = "1";
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    form.addEventListener("submit", ask);
    return () => form.removeEventListener("submit", ask);
  }, [formId, backwards]);
  return (
    <div className="space-y-3">
      <h3 className="ds-label">Status</h3>
      {action ? (
        <SettingsForm id={formId} action={action} submitLabel="Save">
          <input type="hidden" name="confirm" defaultValue="" ref={confirmField} />
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5">
              <span className={labelClass}>Where it stands</span>
              <select
                name="status"
                value={status}
                onChange={(event) => {
                  const next = event.target.value as ApplicationStatus;
                  setStatus(next);
                  // Seed today only when Applied is explicitly chosen as a submission. If that
                  // choice changes to a later stage untouched, its date must become unknown again.
                  if (!row.application?.appliedOn && !appliedOnEdited) setAppliedOnValue(next === "applied" ? today() : "");
                }}
                className={selectClass}
              >
                {APPLICATION_STATUSES.map((value) => (
                  <option key={value} value={value}>{APPLICATION_STATUS_LABELS[value]}</option>
                ))}
              </select>
            </label>
            {/* The day this entry is about — the interview, the offer, the rejection — which the
                save time cannot express. Applied has one already, the application date, and
                Applying has nothing to date yet, so neither is asked twice. */}
            {datesTheEntry && (
              <label className="grid gap-1.5">
                <span className={labelClass}>On (optional)</span>
                <input type="date" name="on" defaultValue="" className={inputClass} />
              </label>
            )}
          </div>
          {/* Outside the label on purpose: inside it, the sentence becomes part of the select's accessible name. */}
          <p className="text-12 text-muted">Withdrawn also dismisses the role.</p>
          {/* Only submission has a required date. A later status may be known without it. */}
          {status !== "applying" && (
            <label className="grid gap-1.5">
              <span className={labelClass}>Application date{status === "applied" ? "" : " (optional)"}</span>
              <input
                type="date"
                name="appliedOn"
                required={status === "applied"}
                value={appliedOnValue}
                onChange={(event) => { setAppliedOnValue(event.target.value); setAppliedOnEdited(true); }}
                className={`max-w-xs ${inputClass}`}
              />
              {status !== "applied" && <span className="text-12 text-muted">Leave blank, or clear an incorrect date, if you do not know when you applied.</span>}
            </label>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5">
              <span className={labelClass}>Next step</span>
              <input
                type="text"
                name="nextAction"
                maxLength={200}
                defaultValue={row.application?.nextAction ?? ""}
                placeholder="Optional, e.g. chase the recruiter"
                className={inputClass}
              />
            </label>
            <label className="grid gap-1.5">
              <span className={labelClass}>Due by</span>
              <input type="date" name="nextActionOn" defaultValue={row.application?.nextActionOn ?? ""} className={inputClass} />
            </label>
          </div>
          <p className="text-12 text-muted">Nothing is sent; it shows under the stage as a reminder.</p>
          <label className="grid gap-1.5">
            <span className={labelClass}>Notes</span>
            <textarea name="notes" defaultValue={row.application?.notes ?? ""} maxLength={4000} rows={3} className={`resize-y ${inputClass}`} />
          </label>
        </SettingsForm>
      ) : (
        <p className="text-14 text-muted">
          This role is no longer in your table, so its status is fixed.
        </p>
      )}
      {history.length > 0 && (
        <section>
          <h4 className="ds-label">Status history</h4>
          <ul className="mt-1 space-y-1 text-13">
            {history.map((entry, index) => (
              // "Interview · on 12 Sep · saved 10 Sep": the day it was about beside the day it was
              // recorded. The exact instant stays on the line, one hover away.
              <li key={`${entry.at}-${index}`} title={entry.at}>
                {historyLine(entry)}
                {entry.notes && ` — ${entry.notes}`}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** The build form, or the sentence that says why it cannot be pressed, once credits are checked. */
function CvBuildControl({ row, jobId, quotes, unverified, buildLabel }: { row: PipelineRow; jobId: string; quotes: QuoteSource; unverified: boolean; buildLabel: string }) {
  const [description, setDescription] = useState("");
  // An unconfirmed account cannot build, so it never waits on the credit read.
  const quote = unverified ? undefined : (isThenable(quotes) ? use(quotes) : quotes)[jobId];
  // The same one-credit price applies whether the stored or pasted advert is used.
  const blocked = unverified ? UNVERIFIED : null;
  const blockedId = `cv-blocked-${row.key.replace(/\s+/g, "-")}`;
  return blocked ? (
    <div className="flex flex-col gap-3">
      <p id={blockedId} className="text-13 text-muted">{blocked}</p>
      <div>
        <Button variant="primary" size="sm" disabled aria-describedby={blockedId}>{buildLabel}</Button>
      </div>
    </div>
  ) : (
    <SettingsForm action={requestCv} submitLabel={buildLabel}
      submitDisabled={!quote || !!quote.refusal}
      submitDescribedBy={quote?.refusal ? blockedId : undefined}>
      <input type="hidden" name="jobId" value={jobId} />
      <label className="grid gap-1.5">
        <span className={labelClass}>Paste a replacement description</span>
        <textarea
          name="description"
          rows={3}
          maxLength={60000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Optional. Leave empty to use the stored description."
          className={`resize-y ${inputClass}`}
        />
      </label>
      {quote && <p className="text-12 text-muted">{quote.line}</p>}
      {quote?.refusal && <p id={blockedId} className="text-13 text-warn">{quote.refusal} <Link prefetch={false} href="/account#top-ups" className="underline">Add CV credits</Link></p>}
      {!quote && <p role="status" className="text-13 text-warn">Could not check your CV credits. Reload and try again.</p>}
    </SettingsForm>
  );
}

function CvPanel({
  row,
  focus,
  quotes,
  unverified,
  onPatched,
}: {
  row: PipelineRow;
  focus: boolean;
  /** What a build would cost this account, per posting id, priced before the button is pressed. */
  quotes: QuoteSource;
  unverified: boolean;
  onPatched: (row: PipelineRow) => void;
}) {
  const router = useRouter();
  const { busy: managing, error: manageError, setError: setManageError, run } = useActionCall();
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => { if (focus) heading.current?.focus(); }, [focus]);
  const buildLabel = row.cv ? "Rebuild CV" : "Build CV";
  /**
   * Archive, restore and delete call the action directly, and the action answers with the row as
   * the database now has it, which the table shows at once. The page is asked for again as well,
   * but nothing waits on that: a refresh that a router already mid-render drops would otherwise
   * leave the cell showing a CV that is gone.
   */
  function runManage(cvId: string, action: "archive" | "restore" | "delete") {
    run(true, async () => {
      const result = await manageRoleCv(row.jobId, cvId, action);
      if (!result.ok) setManageError(result.error);
      else if (result.row) onPatched(result.row);
      router.refresh();
    }, {
      failed: "Could not update this CV. Reload and retry.",
      confirm: action === "delete" ? "Permanently delete this CV? Saved application PDFs will be kept." : undefined,
    });
  }
  return (
    <div className="space-y-3">
      <h3 className="ds-label" tabIndex={-1} ref={heading}>CV</h3>
      {row.cv ? (
        <p className="text-14">
          <Link prefetch={false} href={`/cv/${row.cv.id}`} className="underline">Open CV</Link>
          <span className="ml-2 text-muted">{cvLabel(row)}</span>
        </p>
      ) : (
        <p className="text-14 text-muted">No CV for this role yet.</p>
      )}
      {row.jobId ? (
        // Availability streams in behind the table; until it lands the control waits under the mark.
        <Suspense fallback={<span className="inline-block text-muted"><MarkSmall size={16} searching title="Checking CV credits" /></span>}>
          <CvBuildControl row={row} jobId={row.jobId} quotes={quotes} unverified={unverified} buildLabel={buildLabel} />
        </Suspense>
      ) : (
        <p className="text-13 text-muted">
          No live posting behind this row, so no new CV can be built.
        </p>
      )}
      {/* Archive and delete act on the current CV, restore on the predecessor it replaced. */}
      {(row.cv || row.archivedCvId) && (
        <div className="flex flex-wrap items-center gap-2">
          {row.cv && (
            <>
              <Button type="button" size="sm" disabled={managing} onClick={() => runManage(row.cv!.id, "archive")}>Archive CV</Button>
              <Button type="button" variant="danger" size="sm" disabled={managing} onClick={() => runManage(row.cv!.id, "delete")}>Delete CV</Button>
            </>
          )}
          {row.archivedCvId && (
            <Button type="button" size="sm" disabled={managing} onClick={() => runManage(row.archivedCvId!, "restore")}>Restore previous CV</Button>
          )}
        </div>
      )}
      {manageError && <p className="text-13 text-danger">{manageError}</p>}
      {row.application?.hasPdf && (
        <p className="text-14">
          <a className="underline" href={`/api/applications/${row.application.id}/pdf`}>Download submitted CV</a>
        </p>
      )}
    </div>
  );
}

export function ApplicationsTable({
  rows: inputRows,
  openKey,
  quotes = {},
  nextSteps = {},
  staleHints = {},
  unverified = false,
  emptyState,
}: {
  rows: PipelineRow[];
  /** The row a `?job=` link asks for: opened, with its CV section taking focus. */
  openKey?: string;
  /**
   * Credit availability per posting id, read on the server for the rows on this page. A
   * promise when the page streams it: only an open row's CV section waits for it.
   */
  quotes?: QuoteSource;
  /** "Next: send references · by Tue 23 Sep", per row key, written on the server against its clock. */
  nextSteps?: Record<string, NextStepNote>;
  /** "No update for 3 weeks", per row key, for the rows that have been quiet a fortnight. */
  staleHints?: Record<string, string>;
  /** Whether this account has still to confirm its address, which holds every build back. */
  unverified?: boolean;
  emptyState: React.ReactNode;
}) {
  const [expandedKey, setExpandedKey] = useState<string | null>(openKey ?? null);
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (!window.matchMedia) return;
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  // A `?job=` link, and the CV column's own Build CV, both open the row on its CV section.
  const [focusedCvKey, setFocusedCvKey] = useState<string | null>(openKey ?? null);
  function openCv(key: string) { setExpandedKey(key); setFocusedCvKey(key); }
  // Rows a CV action has just answered for, shown in place of what the page last rendered. The
  // next render from the server carries the same truth and clears them.
  const [patched, setPatched] = useState<Record<string, PipelineRow>>({});
  useEffect(() => { setPatched({}); }, [inputRows]);
  const rows = inputRows.map((row) => patched[row.key] ?? row);
  if (!rows.length) return <>{emptyState}</>;
  const detailsFor = (row: PipelineRow) => <div className="grid gap-6 md:grid-cols-2">
    <StatusPanel row={row} />
    <CvPanel row={row} focus={focusedCvKey === row.key} quotes={quotes} unverified={unverified}
      onPatched={(fresh) => setPatched((previous) => ({ ...previous, [fresh.key]: fresh }))} />
  </div>;
  return (
    <>
    <div className="hidden md:block">
    <Table>
      <THead>
        <tr>
          <TH>Company</TH>
          <TH>Role</TH>
          <TH>Status</TH>
          <TH>CV</TH>
          <TH>Updated</TH>
        </tr>
      </THead>
      <TBody>
        {rows.map((row) => {
          const expanded = expandedKey === row.key;
          return (
            <Fragment key={row.key}>
              <TR>
                <TD className="max-w-[14rem]">
                  {row.companyId ? (
                    <a href={`/companies/${row.companyId}`} className="flex items-center gap-1.5 no-underline hover:underline">
                      <CompanyFavicon src={row.companyIcon?.src ?? null} domain={row.companyIcon?.domain} size={14} />
                      <span className="truncate">{row.companyName}</span>
                    </a>
                  ) : (
                    <span className="truncate">{row.companyName}</span>
                  )}
                </TD>
                <TD className="max-w-[22rem]">
                  <button
                    type="button"
                    onClick={() => { setExpandedKey(expanded ? null : row.key); setFocusedCvKey(null); }}
                    aria-expanded={expanded}
                    aria-controls={`application-${row.key}`}
                    className="text-left font-semibold text-fg hover:underline"
                  >
                    {row.jobTitle}
                  </button>
                  {row.jobUrl && (
                    <p className="mt-1 text-12">
                      <a href={row.jobUrl} target="_blank" rel="noopener noreferrer" className="text-muted underline">View vacancy ↗</a>
                    </p>
                  )}
                </TD>
                <TD className="max-w-[18rem]">
                  <Badge tone={stageTone(row.stage)}>{stageLabel(row)}</Badge>
                  {/* What the person owes this row next, in their own words. Past its day it stops
                      being a plan and asks for the outcome, which is why it reads in warning ink. */}
                  {nextSteps[row.key] && (
                    <span className={`mt-1 block text-12 ${nextSteps[row.key]!.overdue ? "text-warn" : "text-muted"}`}>
                      {nextSteps[row.key]!.line}
                    </span>
                  )}
                </TD>
                <TD className="max-w-[14rem]">
                  {row.cv ? (
                    <Link prefetch={false} href={`/cv/${row.cv.id}`} className="underline">{cvLabel(row)}</Link>
                  ) : row.jobId ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-muted">—</span>
                      <Button size="sm" aria-expanded={expanded} aria-controls={`application-${row.key}`} onClick={() => openCv(row.key)}>Build CV</Button>
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                  {row.archivedCvId && <span className="mt-1 block text-12 text-muted">· previous archived</span>}
                </TD>
                <TD className="whitespace-nowrap">
                  <time dateTime={new Date(row.updatedAt).toISOString()} title={new Date(row.updatedAt).toISOString()}>
                    {relativeTime(new Date(row.updatedAt))}
                  </time>
                  {/* A hint, not a reminder: nothing is sent, it only reads differently here. */}
                  {staleHints[row.key] && <span className="mt-1 block text-12 text-muted">{staleHints[row.key]}</span>}
                </TD>
              </TR>
              {expanded && !isMobile && (
                <tr id={`application-${row.key}`} className="bg-sunken">
                  <td colSpan={5} className="p-4">
                    {detailsFor(row)}
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </TBody>
    </Table>
    </div>
    <div className="divide-y divide-line-faint border-2 border-line md:hidden" aria-label="Applications">
      {rows.map((row) => {
        const expanded = expandedKey === row.key;
        return <article key={row.key} className="min-w-0 p-4">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              {row.companyId ? <Link prefetch={false} href={`/companies/${row.companyId}`} className="inline-flex max-w-full items-center gap-1.5 text-13 text-muted underline">
                <CompanyFavicon src={row.companyIcon?.src ?? null} domain={row.companyIcon?.domain} size={14} />
                <span className="truncate">{row.companyName}</span>
              </Link> : <span className="block truncate text-13 text-muted">{row.companyName}</span>}
              <button type="button" onClick={() => { setExpandedKey(expanded ? null : row.key); setFocusedCvKey(null); }}
                aria-expanded={expanded} aria-controls={`application-${row.key}`}
                className="mt-1 block min-h-11 w-full text-left font-semibold leading-snug text-fg underline-offset-2 hover:underline">{row.jobTitle}</button>
            </div>
            <Badge tone={stageTone(row.stage)}>{stageLabel(row)}</Badge>
          </div>
          {row.jobUrl && <a href={row.jobUrl} target="_blank" rel="noopener noreferrer" className="mt-1 block min-h-11 py-2 text-13 underline">View vacancy ↗</a>}
          {nextSteps[row.key] && <p className={`mt-2 text-13 ${nextSteps[row.key]!.overdue ? "text-warn" : "text-muted"}`}>{nextSteps[row.key]!.line}</p>}
          {staleHints[row.key] && <p className="mt-2 text-12 text-muted">{staleHints[row.key]}</p>}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-13">
            {row.cv ? <Link prefetch={false} href={`/cv/${row.cv.id}`} className="min-h-11 py-2 underline">CV: {cvLabel(row)}</Link>
              : row.jobId ? <Button size="sm" aria-expanded={expanded} aria-controls={`application-${row.key}`} onClick={() => openCv(row.key)}>Build CV</Button>
              : <span className="text-muted">No CV</span>}
            <time dateTime={new Date(row.updatedAt).toISOString()} className="text-12 text-muted">Updated {relativeTime(new Date(row.updatedAt))}</time>
          </div>
          {row.archivedCvId && <p className="text-12 text-muted">Previous CV archived</p>}
          {expanded && isMobile && <div id={`application-${row.key}`} className="mt-4 border-t border-line-faint pt-4">{detailsFor(row)}</div>}
        </article>;
      })}
    </div>
    </>
  );
}
