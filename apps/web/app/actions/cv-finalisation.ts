"use server";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { cvDrafts, cvPdfs } from "@col/db/schema";
import { canonicalJson, cvAssessmentCurrent } from "@col/core/cv-review";
import { CvContentSchema, CvLibrarySchema } from "@col/core/cv";
import { CvTargetingBriefSchema, cvTargetedSummaryFinalisationIssue } from "@col/core/cv-targeting";
import { cvEmploymentDisplay, cvManualHeadingWarnings } from "@col/core/cv-employment-display";
import { cvEvaluationRows } from "@/lib/cv-evaluation";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { cvDraftEditBaseHash } from "@/lib/cv-edit-base";
import { cvPdfContentHash } from "@/lib/cv-pdf-store";
import { sessionSecret } from "@/lib/session";
import { refuseCvRender, CV_RENDER_BUSY_SENTENCE } from "@/lib/cv-render-limit";
import { actionError, UserFacingError, zUuid } from "@/lib/validation";
import { revalidatePath } from "next/cache";

const TOKEN_LIFETIME_MS = 10 * 60_000;
type Draft = typeof cvDrafts.$inferSelect;
type Warning = { id: string; text: string };
type Prepared = { ok: true; token: string; measuredPages: number; maxPages: number;
  assessmentState: "current" | "stale" | "unchecked"; warnings: Warning[] };
type Failure = { ok: false; error: string };
type TokenData = { userId: string; draftId: string; revision: number; identity: string;
  measuredPages: number; maxPages: number; warningHash: string; assessmentState: Prepared["assessmentState"]; expires: number };

function warningHash(warnings: Warning[]): string {
  return createHash("sha256").update(canonicalJson(warnings)).digest("hex");
}

function assertReady(draft: Draft | undefined): asserts draft is Draft & { content: NonNullable<Draft["content"]> } {
  if (!draft || draft.status !== "ready" || !draft.content || draft.finalisedAt || draft.archivedAt)
    throw new UserFacingError("Open a saved, ready CV revision before finalising it.");
}

function identity(draft: Draft): string {
  return createHmac("sha256", secret()).update(canonicalJson({
    revision: draft.revision, content: draft.content, targetingBrief: draft.targetingBrief,
    librarySnapshot: draft.librarySnapshot, jobDescription: draft.jobDescription,
    assessment: draft.assessment, reviewDecision: draft.reviewDecision,
    rendererContentHash: cvPdfContentHash(draft.content),
  })).digest("hex");
}

function secret(): string {
  const value = sessionSecret();
  if (!value) throw new Error("Session signing is unavailable");
  return value;
}

function sign(data: TokenData): string {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  const signature = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verify(token: string): TokenData {
  if (token.length > 2000) throw new UserFacingError("Reload the CV and review its final PDF again.");
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new UserFacingError("Reload the CV and review its final PDF again.");
  const signature = createHmac("sha256", secret()).update(parts[0]).digest();
  const supplied = Buffer.from(parts[1], "base64url");
  if (supplied.length !== signature.length || !timingSafeEqual(supplied, signature))
    throw new UserFacingError("Reload the CV and review its final PDF again.");
  const data = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as TokenData;
  if (!Number.isSafeInteger(data.expires) || data.expires < Date.now() ||
      !Number.isSafeInteger(data.measuredPages) || data.measuredPages < 1 ||
      !/^[a-f0-9]{64}$/.test(data.warningHash))
    throw new UserFacingError("This PDF review has expired. Review the saved CV again.");
  return data;
}

function warningsFor(draft: Draft, measuredPages: number, maxPages: number): { warnings: Warning[]; assessmentState: Prepared["assessmentState"] } {
  const content = CvContentSchema.parse(draft.content);
  const library = CvLibrarySchema.parse(draft.librarySnapshot);
  const current = cvAssessmentCurrent(draft.assessment, content, draft.jobDescription, library)
    && draft.assessment?.pageCount === measuredPages;
  const assessmentState = current ? "current" : draft.assessment ? "stale" : "unchecked";
  const warnings: Warning[] = [];
  if (!current) warnings.push({ id: "assessment", text: "This saved wording has not been checked. Factual support and role match are unverified." });
  if (measuredPages > maxPages) warnings.push({ id: "page-limit", text: `This PDF measures ${measuredPages} pages against your ${maxPages}-page limit. All pages will be saved.` });
  if (draft.editingMode === "manual") warnings.push(...cvManualHeadingWarnings(content, library));
  if (current && draft.assessment) {
    for (const claim of draft.assessment.review.claims.filter(claim => claim.status !== "supported"))
      warnings.push({ id: `claim:${claim.claimId}`, text: `A factual claim remains ${claim.status}. Review the assessment before approving.` });
    for (const row of cvEvaluationRows(draft.assessment, content, library)
      .filter(row => row.importance === "essential" && row.experience !== "Strong"))
      warnings.push({ id: `essential:${row.id}`, text: `Essential requirement needs review: ${row.requirement}` });
  }
  const brief = draft.targetingBrief ? CvTargetingBriefSchema.parse(draft.targetingBrief) : null;
  const summaryIssue = cvTargetedSummaryFinalisationIssue(content, brief, current ? draft.assessment : null);
  if (summaryIssue) warnings.push({ id: "summary-source", text: summaryIssue });
  return { warnings, assessmentState };
}

async function render(draft: Draft) {
  const content = CvContentSchema.parse(draft.content);
  if (!content.name.trim() || !content.summary.trim() ||
      !content.sections.some(section => section.heading.trim() && section.bullets.some(bullet => bullet.trim())) ||
      content.sections.some(section => !section.heading.trim() || section.bullets.some(bullet => !bullet.trim())))
    throw new UserFacingError("Add meaningful name, summary, section headings and wording before finalising this CV.");
  const library = CvLibrarySchema.parse(draft.librarySnapshot);
  const { renderCvPdfWithReport } = await import("@/lib/cv-pdf");
  const result = await renderCvPdfWithReport(content,
    draft.editingMode === "manual" ? undefined : cvEmploymentDisplay(content, library));
  if (!Number.isSafeInteger(result.pageCount) || result.pageCount < 1 || result.pdf.length < 5)
    throw new UserFacingError("This CV could not be rendered as a valid PDF. Edit and save it before trying again.");
  return result;
}

/** Measure the exact saved revision before asking for deliberate final approval. */
export async function prepareCvFinalisation(id: string, expectedRevision: number, baseHash: string): Promise<Prepared | Failure> {
  const user = await requireUser();
  try {
    zUuid().parse(id);
    const [draft] = await db().select().from(cvDrafts).where(and(eq(cvDrafts.id, id), eq(cvDrafts.userId, user.id)));
    assertReady(draft);
    const active = await db().execute<{ active: boolean }>(sql`select exists (
      select 1 from tasks where payload->>'draftId' = ${id} and status in ('queued', 'running')
    ) as active`);
    if (active.rows[0]?.active) throw new UserFacingError("Wait for this CV's current work to finish before finalising it.");
    if (draft.revision !== expectedRevision || cvDraftEditBaseHash(draft.content, draft.targetingBrief) !== baseHash)
      throw new UserFacingError("This saved CV changed. Reload it before finalising.");
    if (await refuseCvRender(user.id)) throw new UserFacingError(CV_RENDER_BUSY_SENTENCE);
    const result = await render(draft);
    const { warnings, assessmentState } = warningsFor(draft, result.pageCount, result.maxPages);
    return { ok: true, token: sign({ userId: user.id, draftId: id, revision: draft.revision,
      identity: identity(draft), measuredPages: result.pageCount, maxPages: result.maxPages,
      warningHash: warningHash(warnings), assessmentState, expires: Date.now() + TOKEN_LIFETIME_MS }),
      measuredPages: result.pageCount, maxPages: result.maxPages, assessmentState, warnings };
  } catch (error) {
    const result = actionError(error, "Could not prepare the final PDF. Please try again.");
    return { ok: false, error: result.ok ? "Could not prepare the final PDF. Please try again." : result.error };
  }
}

/** Revalidate and store the exact approved PDF atomically, without queuing a build or assessment. */
export async function approveCvFinalisation(id: string, token: string, acknowledged: boolean): Promise<{ ok: true } | Failure> {
  const user = await requireUser();
  try {
    zUuid().parse(id);
    if (acknowledged !== true) throw new UserFacingError("Confirm that you want to finalise this saved CV and its listed warnings.");
    const approved = verify(token);
    if (approved.userId !== user.id || approved.draftId !== id)
      throw new UserFacingError("Reload the CV and review its final PDF again.");
    await db().transaction(async tx => {
      const [draft] = await tx.select().from(cvDrafts)
        .where(and(eq(cvDrafts.id, id), eq(cvDrafts.userId, user.id))).for("update");
      assertReady(draft);
      const active = await tx.execute<{ active: boolean }>(sql`select exists (
        select 1 from tasks where payload->>'draftId' = ${id} and status in ('queued', 'running')
      ) as active`);
      if (active.rows[0]?.active) throw new UserFacingError("Wait for this CV's current work to finish before finalising it.");
      if (draft.revision !== approved.revision || identity(draft) !== approved.identity)
        throw new UserFacingError("This saved CV changed. Reload it before finalising.");
      const result = await render(draft);
      const { warnings, assessmentState } = warningsFor(draft, result.pageCount, result.maxPages);
      if (result.pageCount !== approved.measuredPages || result.maxPages !== approved.maxPages ||
          assessmentState !== approved.assessmentState ||
          warningHash(warnings) !== approved.warningHash)
        throw new UserFacingError("The PDF or its warnings changed. Review it again before finalising.");
      await tx.insert(cvPdfs).values({ draftId: id, userId: user.id,
        contentHash: cvPdfContentHash(draft.content), bytes: result.pdf,
        approvalMode: assessmentState === "current" ? "checked" : "unchecked",
        approvalHash: approved.identity, measuredPages: result.pageCount,
        acknowledgedWarnings: warnings.map(warning => warning.id) });
      await tx.update(cvDrafts).set({ finalisedAt: new Date() }).where(eq(cvDrafts.id, id));
    });
  } catch (error) {
    return actionError(error, "Could not finalise the CV. Please try again.");
  }
  revalidatePath(`/cv/${id}`);
  return { ok: true };
}
