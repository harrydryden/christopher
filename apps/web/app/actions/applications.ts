"use server";
import { assertCvFinalisable } from "@christopher/core/cv-review";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { applications, companies, cvDrafts, jobs, userJobs, type ApplicationStatus } from "@christopher/db";
import { APPLICATION_STATUSES, CvContentSchema, applicationStage, roleStageRank } from "@christopher/core";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { renderCvPdf } from "@/lib/cv-pdf";
import { decide } from "@/app/actions/decisions";
import { actionError, fail, ok, UserFacingError, zUuid, type ActionResult } from "@/lib/validation";
import { revalidatePath } from "next/cache";

type Transaction = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];
type HistoryEntry = { status: string; at: string; notes: string };

const statuses: readonly ApplicationStatus[] = APPLICATION_STATUSES;

/** A calendar day the browser's date input produces, and nothing else. */
function isCalendarDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * How far an application status has got, on the lifecycle's own scale. Used to decide whether a
 * later event may move a row backwards: recording a submitted CV against a role already at
 * interview, or already rejected, must not reset it to "applied".
 */
function beyondApplied(status: ApplicationStatus): boolean {
  return roleStageRank(applicationStage(status)) > roleStageRank("applied");
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
  let withdrawn = false;
  try {
    zUuid().parse(jobId);
    const status = String(form.get("status") ?? "") as ApplicationStatus;
    if (!statuses.includes(status)) return fail("Choose a status from the list.");
    const notes = String(form.get("notes") ?? "").trim();
    if (notes.length > 4000) return fail("Keep notes under 4,000 characters.");
    const supplied = String(form.get("appliedOn") ?? "").trim();
    // The date only means anything once something was submitted; before that there is nothing to
    // date, so "Applying" leaves the field out and the row carries today as a placeholder.
    if (supplied && !isCalendarDay(supplied)) return fail("Enter a valid application date.");
    if (!supplied && status !== "applying" && form.has("appliedOn")) return fail("Enter a valid application date.");
    withdrawn = status === "withdrawn";
    await db().transaction(async (tx) => {
      // The same lock `decide` takes, in the same order, so a stage change and a decision on one
      // role cannot interleave.
      const [view] = await tx
        .select({ jobId: userJobs.jobId })
        .from(userJobs)
        .where(and(eq(userJobs.userId, user.id), eq(userJobs.jobId, jobId)))
        .for("update");
      if (!view) throw new UserFacingError("Role not found.");
      const [role] = await tx
        .select({ title: jobs.title, companyId: companies.id, companyName: companies.name })
        .from(jobs)
        .innerJoin(companies, eq(companies.id, jobs.companyId))
        .where(eq(jobs.id, jobId))
        .limit(1);
      if (!role) throw new UserFacingError("Role not found.");
      companyId = role.companyId;
      const at = new Date().toISOString();
      const existing = await latestApplicationRow(tx, user.id, jobId);
      if (!existing) {
        // A CV already built for this role is the revision this stage is about, so the row starts
        // pointing at it; nothing was submitted through us, so it stores no PDF.
        const [draft] = await tx
          .select({ id: cvDrafts.id })
          .from(cvDrafts)
          .where(and(eq(cvDrafts.userId, user.id), eq(cvDrafts.jobId, jobId), eq(cvDrafts.status, "ready"), isNull(cvDrafts.archivedAt)))
          .orderBy(desc(cvDrafts.createdAt), desc(cvDrafts.id))
          .limit(1);
        await tx.insert(applications).values({
          userId: user.id, jobId, cvId: draft?.id ?? null, pdfBase64: null,
          jobTitle: role.title, companyName: role.companyName,
          appliedOn: supplied || today(), status, notes,
          history: [{ status, at, notes }] satisfies HistoryEntry[],
        });
        return;
      }
      await tx
        .update(applications)
        .set({
          status,
          notes,
          ...(supplied ? { appliedOn: supplied } : {}),
          history: [...existing.history, { status, at, notes }],
        })
        .where(eq(applications.id, existing.id));
    });
  } catch (error) {
    return actionError(error, "Could not update this role. Please try again.");
  }
  // Withdrawing is a decision about the role as well as a status, and `decide` is what writes one:
  // it supersedes the previous decision, records the event and re-teaches the ranking. It takes
  // the same row lock, so it runs after the transaction above rather than inside it.
  if (withdrawn) {
    const result = await decide(jobId, "skip", "Withdrawn from application");
    if (!result.ok) return result;
  }
  revalidatePath("/applications");
  revalidatePath("/", "layout");
  if (companyId) revalidatePath(`/companies/${companyId}`);
  return ok();
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
    if (!isCalendarDay(appliedOn)) return fail("Enter a valid application date.");
    const notes = String(form.get("notes") ?? "").trim();
    if (notes.length > 4000) return fail("Keep notes under 4,000 characters.");
    await db().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`application:${cvId}`}))`);
      // Only a row that already stores the submitted bytes is a duplicate; a row with a stage on
      // it and no PDF is this same application, waiting for the CV that was sent.
      const submitted = await tx
        .select({ id: applications.id })
        .from(applications)
        .where(and(eq(applications.cvId, cvId), sql`${applications.pdfBase64} is not null`));
      if (submitted.length) throw new UserFacingError("This CV revision already has an application record.");
      const [draft] = await tx.select().from(cvDrafts).where(and(eq(cvDrafts.id, cvId), eq(cvDrafts.userId, user.id))).for("share");
      if (!draft || draft.status !== "ready" || !draft.content) throw new UserFacingError("Choose a completed, saved CV.");
      if (!draft.finalisedAt)
        throw new UserFacingError(
          "Review the assessment and finalise this CV before recording an application.",
        );
      // The reviewer's own words about what is missing are written for the person reading them.
      try {
        assertCvFinalisable({ ...draft, content: draft.content });
      } catch (error) {
        throw new UserFacingError(error instanceof Error ? error.message : "This CV cannot be finalised yet.");
      }
      const pdf = await renderCvPdf(CvContentSchema.parse(draft.content));
      jobId = draft.jobId;
      const at = new Date().toISOString();
      const existing = jobId ? await latestApplicationRow(tx, user.id, jobId) : null;
      if (existing && !existing.pdfBase64) {
        // A role already at interview or already closed does not go back to "applied" because the
        // CV that was sent has now been recorded against it.
        const status = beyondApplied(existing.status) ? existing.status : "applied";
        await tx
          .update(applications)
          .set({ cvId, pdfBase64: pdf.toString("base64"), appliedOn, status, notes, history: [...existing.history, { status, at, notes }] })
          .where(eq(applications.id, existing.id));
        return;
      }
      await tx.insert(applications).values({
        userId: user.id, cvId, jobId, jobTitle: draft.jobTitle, companyName: draft.companyName, appliedOn, notes,
        pdfBase64: pdf.toString("base64"), status: "applied", history: [{ status: "applied", at, notes }],
      });
    });
  } catch (error) { return actionError(error, "Could not record application. Please try again."); }
  revalidatePath("/applications"); revalidatePath(`/cv/${cvId}`);
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
    const status = String(form.get("status") ?? "") as ApplicationStatus;
    const notes = String(form.get("notes") ?? "").trim();
    if (!statuses.includes(status) || notes.length > 4000)
      return fail(
        "Choose a valid status and keep notes under 4,000 characters.",
      );
    const supplied = String(form.get("appliedOn") ?? "").trim();
    if (supplied && !isCalendarDay(supplied)) return fail("Enter a valid application date.");
    await db().transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(applications)
        .where(and(eq(applications.id, id), eq(applications.userId, user.id)))
        .for("update");
      if (!row) throw new UserFacingError("Application not found.");
      await tx
        .update(applications)
        .set({
          status,
          notes,
          ...(supplied ? { appliedOn: supplied } : {}),
          history: [
            ...row.history,
            { status, notes, at: new Date().toISOString() },
          ],
        })
        .where(eq(applications.id, id));
    });
  } catch (error) {
    return actionError(error, "Could not update the application. Please try again.");
  }
  revalidatePath("/applications");
  return ok();
}
