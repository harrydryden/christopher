"use server";
import { assertCvFinalisable } from "@christopher/core/cv-review";
import { and, eq, sql } from "drizzle-orm";
import { applications, cvDrafts, type ApplicationStatus } from "@christopher/db";
import { CvContentSchema } from "@christopher/core";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { renderCvPdf } from "@/lib/cv-pdf";
import { actionError, fail, ok, UserFacingError, zUuid, type ActionResult } from "@/lib/validation";
import { revalidatePath } from "next/cache";

const statuses: ApplicationStatus[] = ["applied", "screening", "interview", "offer", "rejected", "withdrawn", "accepted"];
export async function recordApplication(cvId: string, _prev: ActionResult, form: FormData): Promise<ActionResult> {
  const user = await requireUser();
  try {
    zUuid().parse(cvId);
    const appliedOn = String(form.get("appliedOn") ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(appliedOn) || !Number.isFinite(Date.parse(appliedOn)) || new Date(appliedOn).toISOString().slice(0, 10) !== appliedOn) return fail("Enter a valid application date.");
    const notes = String(form.get("notes") ?? "").trim();
    if (notes.length > 4000) return fail("Keep notes under 4,000 characters.");
    await db().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`application:${cvId}`}))`);
      if ((await tx.select({ id: applications.id }).from(applications).where(eq(applications.cvId, cvId))).length) throw new UserFacingError("This CV revision already has an application record.");
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
      await tx.insert(applications).values({ userId: user.id, cvId, jobTitle: draft.jobTitle, companyName: draft.companyName, appliedOn, notes,
        pdfBase64: pdf.toString("base64"), status: "applied", history: [{ status: "applied", at: new Date().toISOString(), notes }] });
    });
  } catch (error) { return actionError(error, "Could not record application. Please try again."); }
  revalidatePath("/applications"); revalidatePath(`/cv/${cvId}`);
  return ok();
}
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
