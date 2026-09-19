"use client";

import { Fragment, startTransition, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  APPLICATION_STATUSES,
  APPLICATION_STATUS_LABELS,
  ROLE_STAGE_LABELS,
  type ApplicationStatus,
} from "@christopher/core/role-workflow";
import { Badge, stageTone } from "@/components/Badge";
import { Button } from "@/components/Button";
import { CompanyFavicon } from "@/components/CompanyFavicon";
import { inputClass, labelClass, selectClass } from "@/components/Field";
import { SettingsForm } from "@/components/SettingsForm";
import { Table, TBody, TD, TH, THead, TR } from "@/components/table";
import { manageRoleCv, setRoleStage, updateApplication } from "@/app/actions/applications";
import { requestCv } from "@/app/actions/cv";
import { relativeTime } from "@/lib/format";
import type { PipelineRow } from "@/lib/queries/applications";


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
    case "generating": return "Building…";
    case "failed": return "Failed";
    case "ready": return `Ready · V${Math.max(1, row.cv.revision)}${row.cv.finalisedAt ? " · finalised" : ""}`;
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The status control writes through the role when there is one, and by row id when there is not. */
function statusAction(row: PipelineRow) {
  if (row.jobId) return setRoleStage.bind(null, row.jobId);
  if (row.application) return updateApplication.bind(null, row.application.id);
  return null;
}

function StatusPanel({ row }: { row: PipelineRow }) {
  const action = statusAction(row);
  const [status, setStatus] = useState<ApplicationStatus>(row.application?.status ?? "applying");
  const history = [...(row.application?.history ?? [])].reverse();
  return (
    <div className="space-y-3">
      <h3 className="ds-label">Status</h3>
      {action ? (
        <SettingsForm action={action} submitLabel="Save">
          <label className="grid gap-1.5">
            <span className={labelClass}>Where it stands</span>
            <select
              name="status"
              value={status}
              onChange={(event) => setStatus(event.target.value as ApplicationStatus)}
              className={selectClass}
            >
              {APPLICATION_STATUSES.map((value) => (
                <option key={value} value={value}>{APPLICATION_STATUS_LABELS[value]}</option>
              ))}
            </select>
          </label>
          {/* Outside the label on purpose: inside it, the sentence becomes part of the select's accessible name. */}
          <p className="text-12 text-muted">Withdrawn dismisses the role, as passing on it from Roles does.</p>
          {/* Nothing has been submitted while a CV is still being written, so there is no date to
              record until the status says there is. */}
          {status !== "applying" && (
            <label className="grid gap-1.5">
              <span className={labelClass}>Application date</span>
              <input
                type="date"
                name="appliedOn"
                required
                defaultValue={row.application?.appliedOn || today()}
                className={`max-w-xs ${inputClass}`}
              />
            </label>
          )}
          <label className="grid gap-1.5">
            <span className={labelClass}>Notes</span>
            <textarea name="notes" defaultValue={row.application?.notes ?? ""} maxLength={4000} rows={3} className={`resize-y ${inputClass}`} />
          </label>
        </SettingsForm>
      ) : (
        <p className="text-14 text-muted">
          This role is no longer in your table, so its status cannot be changed here.
        </p>
      )}
      {history.length > 0 && (
        <section>
          <h4 className="ds-label">Status history</h4>
          <ul className="mt-1 space-y-1 text-13">
            {history.map((entry, index) => (
              <li key={`${entry.at}-${index}`}>
                <time dateTime={entry.at} title={entry.at}>{entry.at.slice(0, 10)}</time>
                {" · "}
                {APPLICATION_STATUS_LABELS[entry.status as ApplicationStatus] ?? entry.status}
                {entry.notes && ` — ${entry.notes}`}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function CvPanel({ row, focus, onPatched }: { row: PipelineRow; focus: boolean; onPatched: (row: PipelineRow) => void }) {
  const router = useRouter();
  const [managing, setManaging] = useState(false);
  const [manageError, setManageError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => { if (focus) heading.current?.focus(); }, [focus]);
  /**
   * Archive, restore and delete call the action directly, and the action answers with the row as
   * the database now has it, which the table shows at once. The page is asked for again as well,
   * but nothing waits on that: a refresh that a router already mid-render drops would otherwise
   * leave the cell showing a CV that is gone.
   */
  function runManage(cvId: string, action: "archive" | "restore" | "delete") {
    if (managing) return;
    if (action === "delete" && !confirm("Permanently delete this CV? Saved application PDFs will be kept.")) return;
    setManaging(true);
    setManageError(null);
    startTransition(async () => {
      try {
        const result = await manageRoleCv(row.jobId, cvId, action);
        if (!result.ok) setManageError(result.error);
        else if (result.row) onPatched(result.row);
        router.refresh();
      } catch {
        setManageError("Could not update this CV. Reload to check the current state before retrying.");
      } finally {
        setManaging(false);
      }
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
        <SettingsForm action={requestCv} submitLabel={row.cv ? "Rebuild CV" : "Build CV"}>
          <input type="hidden" name="jobId" value={row.jobId} />
          <label className="grid gap-1.5">
            <span className={labelClass}>Paste a replacement description</span>
            <textarea
              name="description"
              rows={3}
              maxLength={60000}
              placeholder="Optional. Leave empty to use the description we stored for this role."
              className={`resize-y ${inputClass}`}
            />
          </label>
        </SettingsForm>
      ) : (
        <p className="text-13 text-muted">
          This row has no live posting behind it, so a new CV cannot be built from it.
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
  emptyState,
}: {
  rows: PipelineRow[];
  /** The row a `?job=` link asks for: opened, with its CV section taking focus. */
  openKey?: string;
  emptyState: React.ReactNode;
}) {
  const [expandedKey, setExpandedKey] = useState<string | null>(openKey ?? null);
  // A `?job=` link, and the CV column's own Build CV, both open the row on its CV section.
  const [focusedCvKey, setFocusedCvKey] = useState<string | null>(openKey ?? null);
  function openCv(key: string) { setExpandedKey(key); setFocusedCvKey(key); }
  // Rows a CV action has just answered for, shown in place of what the page last rendered. The
  // next render from the server carries the same truth and clears them.
  const [patched, setPatched] = useState<Record<string, PipelineRow>>({});
  useEffect(() => { setPatched({}); }, [inputRows]);
  const rows = inputRows.map((row) => patched[row.key] ?? row);
  if (!rows.length) return <>{emptyState}</>;
  return (
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
                <TD>
                  <Badge tone={stageTone(row.stage)}>{stageLabel(row)}</Badge>
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
                </TD>
              </TR>
              {expanded && (
                <tr id={`application-${row.key}`} className="bg-sunken">
                  <td colSpan={5} className="p-4">
                    <div className="grid gap-6 md:grid-cols-2">
                      <StatusPanel row={row} />
                      <CvPanel row={row} focus={focusedCvKey === row.key} onPatched={(fresh) => setPatched((previous) => ({ ...previous, [fresh.key]: fresh }))} />
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </TBody>
    </Table>
  );
}
