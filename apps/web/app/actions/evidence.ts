"use server";

/** A shared, unconfirmed evidence conversation for Experience and the CV gap quiz. */
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { appendConfirmedEvidence, evidenceDraftFingerprint, isActiveStoredEvidence, type EvidenceDraftInput } from "@col/core";
import { cvDrafts, evidenceDrafts, type EvidenceDraft } from "@col/db";
import { requireUser, requireVerifiedUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { enqueue } from "@/lib/enqueue";
import { latestLibrary, writeCvLibraryVersion } from "@/lib/cv-library-write";
import { actionError, fail, UserFacingError, zUuid, type ActionResult } from "@/lib/validation";
import { revalidate } from "@/lib/action-helpers";

const RequestSchema = z.object({
  source: z.enum(["library", "cv_quiz"]),
  sourceId: z.string().uuid().nullish(),
  questionId: z.string().trim().min(1).max(120),
  question: z.string().trim().min(1).max(400),
  answer: z.string().trim().min(1).max(2000),
  destination: z.object({ kind: z.enum(["employment", "evidence"]), id: z.string().trim().min(1).max(120) }),
  baseVersion: z.number().int().min(0),
  facet: z.enum(["responsibility", "problem", "outcome", "metric", "milestone", "style"]).nullish(),
});
const SkipSchema = RequestSchema.omit({ answer: true });

export type EvidenceDraftView = Pick<EvidenceDraft, "id" | "status" | "wording" | "error" | "attempt" | "acceptedVersion"> & {
  questionId: string; answer: string; question: string; destination: EvidenceDraftInput["destination"];
  baseVersion: number; source: EvidenceDraftInput["source"]; sourceId: string | null;
};
const view = (row: EvidenceDraft): EvidenceDraftView => ({
  id: row.id, status: row.status, wording: row.wording, error: row.error, attempt: row.attempt,
  acceptedVersion: row.acceptedVersion, questionId: row.input.questionId, answer: row.input.answer,
  question: row.input.question, destination: row.input.destination,
  baseVersion: row.input.baseVersion, source: row.input.source, sourceId: row.input.sourceId ?? null,
});

async function verifiedInput(userId: string, request: z.infer<typeof RequestSchema>): Promise<EvidenceDraftInput> {
  const stored = await latestLibrary(db(), userId);
  if ((stored?.version ?? 0) !== request.baseVersion || !stored)
    throw new UserFacingError("Experience changed while you answered. Save or reload it, then try again.");
  if (request.source === "cv_quiz") {
    if (!request.sourceId) throw new UserFacingError("This CV question is no longer available.");
    const [cv] = await db().select({ id: cvDrafts.id, status: cvDrafts.status, gapQuiz: cvDrafts.gapQuiz })
      .from(cvDrafts).where(and(eq(cvDrafts.id, request.sourceId), eq(cvDrafts.userId, userId))).limit(1);
    const quiz = cv?.gapQuiz;
    if (cv?.status !== "awaiting_evidence" || !quiz || quiz.status !== "awaiting_answers" ||
        quiz.libraryVersion !== request.baseVersion ||
        !quiz.questions.some(item => item.id === request.questionId && item.prompt === request.question))
      throw new UserFacingError("This CV question changed. Reload the CV before drafting evidence.");
  }
  const job = request.destination.kind === "employment"
    ? stored.content.employment?.find(item => item.id === request.destination.id) : null;
  if (request.destination.kind === "employment") {
    if (!job) throw new UserFacingError("Choose a job still in Experience.");
    const blocks = stored.content.entries.filter(item => item.kind === "experience" && item.employmentId === job.id);
    if (blocks.length && blocks.every(item => !isActiveStoredEvidence(item)))
      throw new UserFacingError("Restore this job before adding evidence to it.");
  } else {
    const block = stored.content.entries.find(item => item.id === request.destination.id);
    if (!block || !isActiveStoredEvidence(block) || block.kind === "experience")
      throw new UserFacingError("Choose an active job or evidence block.");
  }
  return {
    ...request, sourceId: request.sourceId ?? null, facet: request.facet ?? null,
    job: job ? { company: job.company, title: job.jobTitle, startDate: job.startDate,
      endDate: job.endDate, current: job.current } : null,
  };
}

/** Stable fingerprint makes a repeated click, or the same request from another tab, one call. */
export async function requestEvidenceDraft(raw: unknown): Promise<{ ok: true; draft: EvidenceDraftView } | { ok: false; error: string }> {
  const user = await requireVerifiedUser();
  const parsed = RequestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Add an answer, select its destination and try again." };
  try {
    const input = await verifiedInput(user.id, parsed.data);
    const fingerprint = evidenceDraftFingerprint(input);
    const draft = await db().transaction(async tx => {
      const [inserted] = await tx.insert(evidenceDrafts).values({ userId: user.id, fingerprint, input })
        .onConflictDoNothing().returning();
      if (inserted) {
        await enqueue("draft_evidence", { userId: user.id, evidenceDraftId: inserted.id, attempt: 1 }, tx);
        return inserted;
      }
      const [existing] = await tx.select().from(evidenceDrafts)
        .where(and(eq(evidenceDrafts.userId, user.id), eq(evidenceDrafts.fingerprint, fingerprint))).for("update").limit(1);
      if (!existing) throw new Error("The existing evidence request could not be read.");
      if (existing.status === "dismissed") {
        const attempt = existing.attempt + 1;
        const [reopened] = await tx.update(evidenceDrafts).set({ status: "queued", resolvedAt: null,
          attempt, wording: null, error: null, updatedAt: new Date() }).where(eq(evidenceDrafts.id, existing.id)).returning();
        await enqueue("draft_evidence", { userId: user.id, evidenceDraftId: existing.id, attempt }, tx);
        return reopened!;
      }
      return existing;
    });
    return { ok: true, draft: view(draft) };
  } catch (error) {
    const result = actionError(error, "Could not start an evidence draft. Your answer is still in the form.");
    return { ok: false, error: result.ok ? "Could not start an evidence draft." : result.error };
  }
}

export async function retryEvidenceDraft(id: string): Promise<ActionResult> {
  const user = await requireVerifiedUser();
  if (!zUuid().safeParse(id).success) return fail("That evidence draft could not be found.");
  try {
    await db().transaction(async tx => {
      const [row] = await tx.select().from(evidenceDrafts)
        .where(and(eq(evidenceDrafts.id, id), eq(evidenceDrafts.userId, user.id))).for("update").limit(1);
      if (!row || row.resolvedAt) throw new UserFacingError("That evidence draft is no longer open.");
      if (row.status !== "failed") throw new UserFacingError("This draft is already being prepared or ready to review.");
      const stored = await latestLibrary(tx, user.id);
      if ((stored?.version ?? 0) !== row.input.baseVersion)
        throw new UserFacingError("Experience changed since this answer. Reload the latest version before retrying.");
      const [latest] = await tx.select().from(evidenceDrafts).where(eq(evidenceDrafts.id, id));
      const attempt = (latest?.attempt ?? row.attempt) + 1;
      await tx.update(evidenceDrafts).set({ status: "queued", attempt, error: null, wording: null,
        supportingQuotes: null, updatedAt: new Date() }).where(eq(evidenceDrafts.id, id));
      await enqueue("draft_evidence", { userId: user.id, evidenceDraftId: id, attempt }, tx);
    });
    return { ok: true };
  } catch (error) { return actionError(error, "Could not retry this draft."); }
}

/** The person's exact answer can be saved when no draft can be queued or returned. */
export async function confirmEvidenceAnswerAsWritten(raw: unknown, wording: string): Promise<ActionResult & { version?: number }> {
  const user = await requireVerifiedUser();
  const parsed = RequestSchema.safeParse(raw);
  if (!parsed.success || parsed.data.source !== "library") return fail("Add an answer to a saved job first.");
  const exact = wording.trim();
  if (!exact || exact.length > 2000) return fail("Review one evidence row of up to 2,000 characters before saving.");
  try {
    const identity = evidenceDraftFingerprint({ ...parsed.data, sourceId: parsed.data.sourceId ?? null,
      facet: parsed.data.facet ?? null });
    const [already] = await db().select({ status: evidenceDrafts.status, acceptedWording: evidenceDrafts.acceptedWording,
      acceptedVersion: evidenceDrafts.acceptedVersion }).from(evidenceDrafts)
      .where(and(eq(evidenceDrafts.userId, user.id), eq(evidenceDrafts.fingerprint, identity))).limit(1);
    if (already?.status === "accepted") return already.acceptedWording === exact
      ? { ok: true, version: already.acceptedVersion ?? undefined }
      : fail("This answer was already saved with different wording.");
    const input = await verifiedInput(user.id, parsed.data);
    const fingerprint = evidenceDraftFingerprint(input);
    const version = await db().transaction(async tx => {
      const [inserted] = await tx.insert(evidenceDrafts).values({ userId: user.id, fingerprint, input,
        status: "accepted", acceptedWording: exact, resolvedAt: new Date() }).onConflictDoNothing().returning();
      const row = inserted ?? (await tx.select().from(evidenceDrafts).where(and(eq(evidenceDrafts.userId, user.id),
        eq(evidenceDrafts.fingerprint, fingerprint))).for("update").limit(1))[0];
      if (!row) throw new Error("Evidence request could not be found.");
      if (!inserted && row.status === "accepted") {
        if (row.acceptedWording !== exact) throw new UserFacingError("This answer was already saved with different wording.");
        return row.acceptedVersion ?? input.baseVersion + 1;
      }
      // Returning to a skipped question is an explicit new confirmation of the same answer.
      const savedVersion = await writeCvLibraryVersion(tx, user.id, input.baseVersion, current => {
        if (!current) throw new UserFacingError("Save Experience before adding an answer.");
        return appendConfirmedEvidence(current, input, exact, randomUUID());
      });
      await tx.update(evidenceDrafts).set({ status: "accepted", acceptedWording: exact, acceptedVersion: savedVersion,
        resolvedAt: new Date(), updatedAt: new Date() }).where(eq(evidenceDrafts.id, row.id));
      return savedVersion;
    });
    revalidate("/library", "/cv");
    return { ok: true, version };
  } catch (error) { return actionError(error, "Could not save this answer. Your wording is still in the review."); }
}

export async function dismissEvidenceDraft(id: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!zUuid().safeParse(id).success) return fail("That evidence draft could not be found.");
  await db().update(evidenceDrafts).set({ status: "dismissed", resolvedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(evidenceDrafts.id, id), eq(evidenceDrafts.userId, user.id), isNull(evidenceDrafts.resolvedAt)));
  return { ok: true };
}

/** Remember an explicit Nothing further choice for this question and Library version. */
export async function skipEvidenceQuestion(raw: unknown): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = SkipSchema.safeParse(raw);
  if (!parsed.success) return fail("This question could not be skipped.");
  try {
    const input = await verifiedInput(user.id, { ...parsed.data, answer: "" });
    const fingerprint = evidenceDraftFingerprint(input);
    await db().insert(evidenceDrafts).values({ userId: user.id, fingerprint, input,
      status: "dismissed", resolvedAt: new Date() }).onConflictDoNothing();
    return { ok: true };
  } catch (error) { return actionError(error, "Could not remember this choice."); }
}

/** An explicit confirmation writes the exact reviewed wording, once, under the stored base version. */
export async function confirmEvidenceDraft(id: string, wording: string): Promise<ActionResult & { version?: number }> {
  const user = await requireUser();
  if (!zUuid().safeParse(id).success) return fail("That evidence draft could not be found.");
  const exact = wording.trim();
  if (!exact || exact.length > 2000) return fail("Review one evidence row of up to 2,000 characters before saving.");
  try {
    const version = await db().transaction(async tx => {
      const [row] = await tx.select().from(evidenceDrafts)
        .where(and(eq(evidenceDrafts.id, id), eq(evidenceDrafts.userId, user.id))).for("update").limit(1);
      if (!row) throw new UserFacingError("That evidence draft could not be found.");
      if (row.input.source !== "library") throw new UserFacingError("Continue this answer from its CV question.");
      if (row.status === "accepted") {
        if (row.acceptedWording !== exact) throw new UserFacingError("This draft was already saved with different wording.");
        return row.acceptedVersion ?? row.input.baseVersion + 1;
      }
      if (row.resolvedAt || row.status === "dismissed") throw new UserFacingError("This question was dismissed. Start a new answer to add evidence.");
      if (row.status !== "drafted" && row.status !== "failed" && row.status !== "queued")
        throw new UserFacingError("This answer is not ready to confirm.");
      // The person's own answer is always available, including when the model is unavailable.
      // A different edit is accepted only after the affirmative UI action displays that exact text.
      const version = await writeCvLibraryVersion(tx, user.id, row.input.baseVersion, current => {
        if (!current) throw new UserFacingError("Save Experience before adding an answer.");
        try { return appendConfirmedEvidence(current, row.input, exact, randomUUID()); }
        catch (error) { throw new UserFacingError(error instanceof Error ? error.message : "This evidence could not be saved."); }
      });
      await tx.update(evidenceDrafts).set({ status: "accepted", acceptedWording: exact,
        acceptedVersion: version, resolvedAt: new Date(), updatedAt: new Date() })
        .where(eq(evidenceDrafts.id, row.id));
      return version;
    });
    revalidate("/library", "/cv");
    return { ok: true, version };
  } catch (error) { return actionError(error, "Could not save this evidence. Your answer is still in the review."); }
}

/** Open conversations and explicit skips for the current question/version. */
export async function openEvidenceDrafts(source: "library" | "cv_quiz", sourceId: string | null = null): Promise<EvidenceDraftView[]> {
  const user = await requireUser();
  try {
    const rows = await db().select().from(evidenceDrafts)
      .where(and(eq(evidenceDrafts.userId, user.id),
        sql`${evidenceDrafts.input}->>'source' = ${source}`,
        sql`coalesce(${evidenceDrafts.input}->>'sourceId', '') = ${sourceId ?? ""}`,
        sql`(${evidenceDrafts.resolvedAt} is null or ${evidenceDrafts.status} = 'dismissed')`))
      .orderBy(desc(evidenceDrafts.updatedAt)).limit(50);
    return rows.map(view);
  } catch (error) {
    // Web may be released before the worker applies the additive migration.
    if ((error as { code?: string; cause?: { code?: string } }).code === "42P01" ||
        (error as { cause?: { code?: string } }).cause?.code === "42P01") return [];
    throw error;
  }
}
