"use server";
import { assertCvFinalisable } from "@col/core/cv-review";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { actionCvs, applications, companies, cvDrafts, decisions, jobs, lockAccountScoreInput, type ApplicationStatus } from "@col/db";
import { pipelineRowForJob, type PipelineRow } from "@/lib/queries/applications";
import { APPLICATION_STATUSES, APPLICATION_STATUS_LABELS, CvContentSchema, applicationStage, roleStageRank } from "@col/core";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { isRecordableDay } from "@/lib/application-dates";
import { cvPdfFor } from "@/lib/cv-pdf-store";
import { lockRoleView, recordDecisions } from "@/lib/decisions";
import { actionError, fail, ok, UserFacingError, zUuid, type ActionResult } from "@/lib/validation";
import { revalidatePath } from "next/cache";
import { revalidate } from "@/lib/action-helpers";

type Transaction = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];
type HistoryEntry = { status: string; at: string; notes: string; on?: string };

const statuses: readonly ApplicationStatus[] = APPLICATION_STATUSES;

/** What the person owes this application next, in their own words: a note, not a workflow. */
const NEXT_ACTION_MAX = 200;

/**
 * Everything the status control sends, validated once for both the role that has a posting behind
 * it and the record that has not.
 *
 * Three fields carry a day and they mean different things. `appliedOn` is when the application
 * went in. `on` is the day *this entry* is about — the interview, the offer, the rejection — which
 * the save time cannot express and which is the thing people actually track. `nextActionOn` is
 * when the next step is due.
 */
interface StageFields {
  status: ApplicationStatus;
  notes: string;
  appliedOn: string;
  clearAppliedOn: boolean;
  on: string;
  nextAction: string;
  nextActionOn: string;
}

type StageForm = { ok: true; fields: StageFields } | { ok: false; error: string };

/** A refusal in the shape both call sites return straight back to the form. */
const refuse = (error: string): StageForm => ({ ok: false, error });

function readStageForm(form: FormData): StageForm {
  const status = String(form.get("status") ?? "") as ApplicationStatus;
  if (!statuses.includes(status)) return refuse("Choose a status from the list.");
  const notes = String(form.get("notes") ?? "").trim();
  if (notes.length > 4000) return refuse("Keep notes under 4,000 characters.");
  const appliedOn = String(form.get("appliedOn") ?? "").trim();
  if (appliedOn && !isRecordableDay(appliedOn)) return refuse("Enter a valid application date.");
  const clearAppliedOn = form.has("appliedOn") && !appliedOn && status !== "applied";
  const on = String(form.get("on") ?? "").trim();
  if (on && !isRecordableDay(on)) return refuse("Enter a valid date for this update.");
  const nextAction = String(form.get("nextAction") ?? "").trim();
  if (nextAction.length > NEXT_ACTION_MAX) return refuse(`Keep the next step under ${NEXT_ACTION_MAX} characters.`);
  const nextActionOn = String(form.get("nextActionOn") ?? "").trim();
  if (nextActionOn && !isRecordableDay(nextActionOn)) return refuse("Enter a valid date for the next step.");
  return { ok: true, fields: { status, notes, appliedOn, clearAppliedOn, on, nextAction, nextActionOn } };
}

/** The next step as the row stores it: the text and its day, or neither once the text is blank. */
function nextActionColumns(fields: StageFields): { nextAction: string | null; nextActionOn: string | null } {
  if (!fields.nextAction) return { nextAction: null, nextActionOn: null };
  return { nextAction: fields.nextAction, nextActionOn: fields.nextActionOn || null };
}

/**
 * One history entry, dated twice: `at` is when it was saved and `on` is the day it is about.
 * Applied is the one status whose day the row already carries — the application date — so the
 * form does not ask for it twice and this reads it from there.
 */
function historyEntry(fields: StageFields, at: string, appliedOn: string | null): HistoryEntry {
  const on = fields.on || (fields.status === "applied" ? appliedOn : "");
  return { status: fields.status, at, notes: fields.notes, ...(on ? { on } : {}) };
}

/**
 * How far an application status has got, on the lifecycle's own scale. Used to decide whether a
 * later event may move a row backwards: recording a submitted CV against a role already at
 * interview, or already rejected, must not reset it to "applied".
 */
function beyondApplied(status: ApplicationStatus): boolean {
  return roleStageRank(applicationStage(status)) > roleStageRank("applied");
}

/**
 * Moving a row backwards is a real thing to want — an offer withdrawn, a status set by mistake —
 * but it rewrites what the row says happened, and an outcome is the one thing nothing else in the
 * product overwrites. So it is allowed and confirmed rather than refused: the row asks the
 * question before it submits and sends `confirm`, and this is the check behind that, for a form
 * that arrives without one. Same-stage moves (Screening to Interview and back) are not backwards:
 * the three In process steps are one stage.
 */
function movesBackwards(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return roleStageRank(applicationStage(to)) < roleStageRank(applicationStage(from));
}

function confirmBackwards(form: FormData, from: ApplicationStatus, to: ApplicationStatus): string | null {
  if (!movesBackwards(from, to) || String(form.get("confirm") ?? "") === "1") return null;
  return `Confirm the move from ${APPLICATION_STATUS_LABELS[from]} back to ${APPLICATION_STATUS_LABELS[to]} before saving it.`;
}

/** As much of a stored row as a save is compared against. */
type StoredStage = { status: ApplicationStatus; notes: string; appliedOn: string | null; nextAction: string | null; nextActionOn: string | null };

/**
 * A save that changes nothing is not an event. Re-reading a row and pressing Save used to append a
 * history entry, so the history of a role somebody checked on weekly read as a weekly status
 * change. An unsupplied date is not a change either: the field is hidden while a role is Applying,
 * and the day an entry is about is asked for fresh every time rather than carried forward.
 */
function unchanged(existing: StoredStage, next: StageFields): boolean {
  return (
    !recordsEvent(existing, next) &&
    (existing.nextAction ?? "") === next.nextAction &&
    (existing.nextActionOn ?? "") === (next.nextAction ? next.nextActionOn : "")
  );
}

/**
 * Whether something happened to the application, as against the person rewriting what they owe it
 * next. Only an event is appended to the history: a next step is a note somebody revises as the
 * week goes on, and a history of revised reminders is not a history of an application.
 */
function recordsEvent(existing: Pick<StoredStage, "status" | "notes" | "appliedOn">, next: StageFields): boolean {
  return (
    existing.status !== next.status ||
    existing.notes !== next.notes ||
    (!!next.appliedOn && existing.appliedOn !== next.appliedOn) ||
    (next.clearAppliedOn && existing.appliedOn !== null) ||
    !!next.on
  );
}

/** The account's newest application for a posting, locked, or null when it has none. */
async function latestApplicationRow(tx: Transaction, userId: string, jobId: string) {
  const [row] = await tx
    .select()
    .from(applications)
    .where(and(eq(applications.userId, userId), eq(applications.jobId, jobId)))
    .orderBy(desc(applications.createdAt), desc(applications.id))
    .limit(1)
    .for("update");
  return row ?? null;
}

/**
 * Set where a role stands from the applications table, without a submitted CV.
 *
 * Most roles are applied for on the employer's own site, so the stage a person wants to record is
 * usually not tied to a CV we rendered. The first status written for a role creates its
 * `applications` row — the one thing that makes the stage outrank the decision behind it — and
 * every later one updates that row, appending to its history. Whatever a real submission left on
 * the row (the frozen PDF, the revision it came from) is never overwritten here.
 */
export async function setRoleStage(jobId: string, _prev: ActionResult, form: FormData): Promise<ActionResult> {
  const user = await requireUser();
  let companyId: string | null = null;
  try {
    zUuid().parse(jobId);
    const read = readStageForm(form);
    if (!read.ok) return fail(read.error);
    const fields = read.fields;
    const { status, notes, appliedOn: supplied } = fields;
    await db().transaction(async (tx) => {
      await lockAccountScoreInput(tx as unknown as ReturnType<typeof db>, user.id, "exclusive");
      // The role lock `decide` and a CV build take, first, so a stage change, a decision and the
      // first application row of a build never interleave on one role.
      const view = await lockRoleView(tx, user.id, jobId);
      if (!view) throw new UserFacingError("Role not found.");
      const [role] = await tx
        .select({ title: jobs.title, companyId: companies.id,
          companyName: sql<string>`coalesce(${companies.name}, ${jobs.companyLabel}, 'Unknown employer')` })
        .from(jobs)
        .leftJoin(companies, eq(companies.id, jobs.companyId))
        .where(and(eq(jobs.id, jobId), sql`(${jobs.manualOwnerId} is null or ${jobs.manualOwnerId} = ${user.id}::uuid)`))
        .limit(1);
      if (!role) throw new UserFacingError("Role not found.");
      companyId = role.companyId;
      const at = new Date().toISOString();
      const existing = await latestApplicationRow(tx, user.id, jobId);
      if (!existing) {
        if (status === "applied" && !supplied) throw new UserFacingError("Enter the date you applied.");
        // A CV already built for this role is the revision this stage is about, so the row starts
        // pointing at it; nothing was submitted through us, so it stores no PDF.
        const [draft] = await tx
          .select({ id: cvDrafts.id })
          .from(cvDrafts)
          .where(and(eq(cvDrafts.userId, user.id), eq(cvDrafts.jobId, jobId), eq(cvDrafts.status, "ready"), isNull(cvDrafts.archivedAt)))
          .orderBy(desc(cvDrafts.createdAt), desc(cvDrafts.id))
          .limit(1);
        const appliedOn = supplied || null;
        await tx.insert(applications).values({
          userId: user.id, jobId, cvId: draft?.id ?? null, pdfBase64: null,
          jobTitle: role.title, companyName: role.companyName,
          appliedOn, status, notes,
          ...nextActionColumns(fields),
          history: [historyEntry(fields, at, appliedOn)] satisfies HistoryEntry[],
        });
      } else {
        if (status === "applied" && !supplied && !existing.appliedOn) throw new UserFacingError("Enter the date you applied.");
        const refusal = confirmBackwards(form, existing.status, status);
        if (refusal) throw new UserFacingError(refusal);
        // A save that changed nothing writes nothing.
        if (!unchanged(existing, fields)) {
          const appliedOn = supplied || (fields.clearAppliedOn ? null : existing.appliedOn);
          await tx
            .update(applications)
            .set({
              status,
              notes,
              ...(supplied || fields.clearAppliedOn ? { appliedOn } : {}),
              ...nextActionColumns(fields),
              ...(recordsEvent(existing, fields) ? { history: [...existing.history, historyEntry(fields, at, appliedOn)] } : {}),
            })
            .where(eq(applications.id, existing.id));
        }
      }
      // Withdrawing is a decision about the role as well as a status, and it is recorded in this
      // same transaction, after the application write, so the two pages can never disagree about
      // it. It is asked on every save rather than only when the status changes, so a role an
      // earlier failure left without its skip is repaired by saving again, and one that already
      // carries the skip gets no second one.
      if (status === "withdrawn") {
        const [active] = await tx.select({ decision: decisions.decision }).from(decisions)
          .where(and(eq(decisions.userId, user.id), eq(decisions.jobId, jobId), eq(decisions.superseded, false))).limit(1);
        if (active?.decision !== "skip") await recordDecisions(tx, user.id, [jobId], "skip", "Withdrawn from application", "Role not found.");
      }
    });
  } catch (error) {
    return actionError(error, "Could not update this role. Please try again.");
  }
  // The pages that show a role's stage: the pipeline, and the roles table on Roles and on the
  // company page. Not the layout: nothing in it reads a stage.
  revalidate("/applications", "/");
  if (companyId) revalidatePath(`/companies/${companyId}`);
  return ok();
}

/**
 * A draft an application may be recorded from: completed, saved, finalised and, by the reviewer's
 * own rule, still finalisable. The reviewer's words about what is missing are written for the
 * person reading them.
 */
function assertRecordable<T extends Pick<typeof cvDrafts.$inferSelect, "status" | "content" | "finalisedAt" | "assessment" | "jobDescription" | "librarySnapshot" | "reviewDecision">>(draft: T | undefined) {
  if (!draft || draft.status !== "ready" || !draft.content) throw new UserFacingError("Choose a completed, saved CV.");
  if (!draft.finalisedAt) throw new UserFacingError("Review the assessment and finalise this CV before recording an application.");
  const recordable = { ...draft, content: draft.content };
  try {
    assertCvFinalisable(recordable);
  } catch (error) {
    throw new UserFacingError(error instanceof Error ? error.message : "This CV cannot be finalised yet.");
  }
  return recordable;
}

/**
 * Record a submitted CV against a role.
 *
 * This is the CV workspace's own button, and it is the only thing that freezes PDF bytes. When the
 * role already carries a row — a stage set from the applications table before the CV was finished
 * — that row is upgraded rather than duplicated, so one company-role keeps one application.
 */
export async function recordApplication(cvId: string, _prev: ActionResult, form: FormData): Promise<ActionResult> {
  const user = await requireUser();
  let jobId: string | null = null;
  try {
    zUuid().parse(cvId);
    const appliedOn = String(form.get("appliedOn") ?? "");
    if (!isRecordableDay(appliedOn)) return fail("Enter a valid application date.");
    const notes = String(form.get("notes") ?? "").trim();
    if (notes.length > 4000) return fail("Keep notes under 4,000 characters.");
    // Rendering is CPU-bound and can take seconds, so it happens before the transaction opens,
    // from a read of the draft; the transaction then re-reads it under lock and writes only if it
    // is still the revision that was rendered.
    // Only what the check, the render and the comparison under lock read.
    const [rendered] = await db()
      .select({ status: cvDrafts.status, content: cvDrafts.content, finalisedAt: cvDrafts.finalisedAt, assessment: cvDrafts.assessment, jobDescription: cvDrafts.jobDescription, librarySnapshot: cvDrafts.librarySnapshot, reviewDecision: cvDrafts.reviewDecision })
      .from(cvDrafts).where(and(eq(cvDrafts.id, cvId), eq(cvDrafts.userId, user.id)));
    if (!rendered) throw new UserFacingError("Choose a completed, saved CV.");
    // The bytes finalising kept, when they were drawn from exactly this content; otherwise a render,
    // with pdfkit loaded only now. The comparison under the lock below holds either way.
    const recordable = assertRecordable(rendered);
    const { pdf } = await cvPdfFor(user.id, cvId, recordable.content, async (content) => {
      const { renderCvPdf } = await import("@/lib/cv-pdf");
      return renderCvPdf(CvContentSchema.parse(content));
    });
    await db().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`application:${cvId}`}))`);
      // Only a row that already stores the submitted bytes is a duplicate; a row with a stage on
      // it and no PDF is this same application, waiting for the CV that was sent.
      const submitted = await tx
        .select({ id: applications.id })
        .from(applications)
        .where(and(eq(applications.cvId, cvId), sql`${applications.pdfBase64} is not null`));
      if (submitted.length) throw new UserFacingError("This CV revision already has an application record.");
      const [locked] = await tx.select().from(cvDrafts).where(and(eq(cvDrafts.id, cvId), eq(cvDrafts.userId, user.id))).for("share");
      const draft = assertRecordable(locked);
      // The assessment covers the exact wording and appearance, as `finaliseCvDraft` relies on: the
      // same assessment, finalisation and content are the revision that was rendered.
      if (draft.assessment?.inputHash !== rendered.assessment?.inputHash || draft.assessment?.assessedAt !== rendered.assessment?.assessedAt
        || draft.finalisedAt?.getTime() !== rendered.finalisedAt?.getTime() || JSON.stringify(draft.content) !== JSON.stringify(rendered.content)) {
        throw new UserFacingError("This CV changed while its PDF was being prepared. Record the application again.");
      }
      jobId = draft.jobId;
      const at = new Date().toISOString();
      const existing = jobId ? await latestApplicationRow(tx, user.id, jobId) : null;
      if (existing && !existing.pdfBase64) {
        // A role already at interview or already closed does not go back to "applied" because the
        // CV that was sent has now been recorded against it.
        const status = beyondApplied(existing.status) ? existing.status : "applied";
        // An Applied entry is about the day the application went in, which this form asks for; a
        // row already past Applied keeps its own status, and this is not the day that one is about.
        const entry: HistoryEntry = { status, at, notes, ...(status === "applied" ? { on: appliedOn } : {}) };
        await tx
          .update(applications)
          .set({ cvId, pdfBase64: pdf.toString("base64"), appliedOn, status, notes, history: [...existing.history, entry] })
          .where(eq(applications.id, existing.id));
        return;
      }
      await tx.insert(applications).values({
        userId: user.id, cvId, jobId, jobTitle: draft.jobTitle, companyName: draft.companyName, appliedOn, notes,
        pdfBase64: pdf.toString("base64"), status: "applied", history: [{ status: "applied", at, notes, on: appliedOn }],
      });
    });
  } catch (error) { return actionError(error, "Could not record application. Please try again."); }
  revalidate("/applications", `/cv/${cvId}`);
  return ok();
}

/**
 * Update an application row directly, by its id. What the applications table offers for a row with
 * no posting behind it — an application recorded before the link existed, or one whose company has
 * left the catalogue — where there is no `user_jobs` row to lock or to write a decision against.
 */
export async function updateApplication(
  id: string,
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  try {
    zUuid().parse(id);
    const read = readStageForm(form);
    if (!read.ok) return fail(read.error);
    const fields = read.fields;
    const { status, notes, appliedOn: supplied } = fields;
    await db().transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(applications)
        .where(and(eq(applications.id, id), eq(applications.userId, user.id)))
        .for("update");
      if (!row) throw new UserFacingError("Application not found.");
      if (status === "applied" && !supplied && !row.appliedOn) throw new UserFacingError("Enter the date you applied.");
      // The same status control, so the same two rules: an outcome is never walked back without
      // the row asking first, and a save that changes nothing appends nothing.
      const refusal = confirmBackwards(form, row.status, status);
      if (refusal) throw new UserFacingError(refusal);
      if (unchanged(row, fields)) return;
      const appliedOn = supplied || (fields.clearAppliedOn ? null : row.appliedOn);
      await tx
        .update(applications)
        .set({
          status,
          notes,
          ...(supplied || fields.clearAppliedOn ? { appliedOn } : {}),
          ...nextActionColumns(fields),
          ...(recordsEvent(row, fields)
            ? { history: [...row.history, historyEntry(fields, new Date().toISOString(), appliedOn)] }
            : {}),
        })
        .where(eq(applications.id, id));
    });
  } catch (error) {
    return actionError(error, "Could not update the application. Please try again.");
  }
  revalidatePath("/applications");
  return ok();
}

export type ManageRoleCvResult = { ok: true; row: PipelineRow | null } | { ok: false; error: string };

const CV_ACTIONS = ["archive", "restore", "delete"] as const;

/**
 * Archive, restore or delete one CV from its role's row, and hand back the row as the table would
 * show it now. The page is revalidated too, but the row does not wait for that render: what the
 * database holds after the action is in the answer, so the cell follows it at once.
 */
export async function manageRoleCv(jobId: string | null, cvId: string, action: string): Promise<ManageRoleCvResult> {
  const user = await requireUser();
  try {
    zUuid().parse(cvId);
    if (jobId !== null) zUuid().parse(jobId);
    if (!(CV_ACTIONS as readonly string[]).includes(action)) return { ok: false, error: "Choose Archive, Restore or Delete." };
    await actionCvs(db(), user.id, [cvId], action as (typeof CV_ACTIONS)[number]);
    const row = jobId ? await pipelineRowForJob(user.id, jobId) : null;
    // The pages that show a role's CV and stage; nothing in the layout reads either.
    revalidate("/applications", "/");
    revalidatePath("/companies/[id]", "page");
    return { ok: true, row };
  } catch (error) {
    const failed = actionError(error, "Could not update this CV. Please try again.");
    return failed.ok ? { ok: false, error: "Could not update this CV. Please try again." } : failed;
  }
}
