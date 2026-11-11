"use server";

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { PROMPTS, resolveRoute, routedModel } from "@col/ai/prompt-registry";
import { cvSkillEvidenceRows } from "@col/core";
import { CV_INLINE_CONTEXT_LIMIT, CvInlineRequestSchema, cvInlineSelection, type CvInlineInput, type CvInlineResult } from "@col/core/cv-inline-ai";
import { cvInlineEditRuns, cvInlineHash, cvInlineRunView, readCvInlineSource, latestCareerCvEvidence,
  CvAiUsageError, ensureCareerBackfill, lockAccountScoreInput, ensureCvOpportunityForContext, reserveCvAiUsage, settleCvAiUsage, CV_AI_UNITS, type Db } from "@col/db";
import { requireUser, requireVerifiedUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { enqueue } from "@/lib/enqueue";
import { getSettingsFor } from "@/lib/settings";
import { actionError, UserFacingError } from "@/lib/validation";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const failure = (error: unknown): CvInlineResult => {
  const result = actionError(error, "Writing help is unavailable right now. Your wording has not changed.");
  return { ok: false, error: result.ok ? "Writing help is unavailable right now." : result.error,
    ...(error instanceof CvAiUsageError && error.code === "credits"
      ? { recovery: { href: "/account#top-ups", label: "Add role credits" } }
      : error instanceof CvAiUsageError && error.resetAt
        ? { recovery: { resetAt: error.resetAt.toISOString() } } : {}) };
};

export async function requestCvInlineEdit(raw: unknown): Promise<CvInlineResult> {
  const user = await requireVerifiedUser();
  try {
    const parsed = CvInlineRequestSchema.safeParse(raw);
    if (!parsed.success) throw new UserFacingError(parsed.error.issues[0]?.message ?? "Choose the text to change again.");
    const request = parsed.data;
    // First-use graph backfill needs the exclusive score fence; finish it before source locks.
    if (request.action === "inline_tailor") await ensureCareerBackfill(db(), user.id);
    return await db().transaction(async tx => {
      // Serialise double-clicks before source validation: a completed request remains replayable.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`cv_inline:${user.id}:${request.requestKey}`}, 0))`);
      const [prior] = await tx.select().from(cvInlineEditRuns).where(and(
        eq(cvInlineEditRuns.userId, user.id), eq(cvInlineEditRuns.requestKey, request.requestKey)));
      if (prior) {
        if (cvInlineHash(prior.input.request) !== cvInlineHash(request)) throw new UserFacingError("This request changed. Ask for a new change.");
        return { ok: true as const, run: cvInlineRunView(prior) };
      }
      if (request.action === "inline_tailor") await lockAccountScoreInput(tx as unknown as Db, user.id, "shared");
      const source = await readCvInlineSource(tx, user.id, request);
      const selection = cvInlineSelection(request.text, request.selectionStart, request.selectionEnd);
      const settings = await getSettingsFor(user.id, tx);
      const routes = Object.fromEntries((["cv.inline_edit", "cv.inline_verify"] as const).map(id => {
        const route = resolveRoute(PROMPTS[id], settings.stageRoutes);
        return [id, { model: routedModel(route, { cvModel: settings.cvModel, callSite: settings.cvModel }, settings.cvModel), effort: route.effort }];
      }));
      const career = request.action === "inline_tailor"
        ? await latestCareerCvEvidence(tx as unknown as Db, user.id, { roleText: source.description.text }) : null;
      const rows = career ? cvSkillEvidenceRows(career.library) : [];
      const referenced = new Set(source.target.sourceIds);
      rows.sort((a, b) => Number(referenced.has(b.id) || !!source.target.entryId && b.id.includes(source.target.entryId))
        - Number(referenced.has(a.id) || !!source.target.entryId && a.id.includes(source.target.entryId)));
      let remaining = CV_INLINE_CONTEXT_LIMIT;
      const evidence = rows.filter(row => { if (row.text.length > remaining) return false; remaining -= row.text.length; return true; });
      const input: CvInlineInput = { request, descriptionVersionId: source.description.id,
        sourceFingerprint: source.fingerprint, targetFingerprint: cvInlineHash(source.target), selection,
        surrounding: { before: request.text.slice(Math.max(0, selection.start - 500), selection.start),
          after: request.text.slice(selection.end, selection.end + 500) },
        role: request.action === "inline_tailor" ? source.description.text.slice(0, CV_INLINE_CONTEXT_LIMIT) : "",
        roleTruncated: request.action === "inline_tailor" && source.description.text.length > CV_INLINE_CONTEXT_LIMIT,
        evidence, omittedEvidence: rows.length - evidence.length, maxFieldLength: source.target.maxLength,
        model: settings.cvModel, routes, promptVersion: PROMPTS["cv.inline_edit"].version,
        verifierVersion: PROMPTS["cv.inline_verify"].version, careerVersion: career?.careerVersion ?? 0 };
      const { requestKey: _key, acceptRoleCredit: _consent, priceVersion: _price, ...semanticRequest } = request;
      const inputHash = cvInlineHash({ ...input, request: semanticRequest });
      const [cached] = await tx.select().from(cvInlineEditRuns).where(and(eq(cvInlineEditRuns.userId, user.id),
        eq(cvInlineEditRuns.contextId, request.contextId), eq(cvInlineEditRuns.inputHash, inputHash),
        or(inArray(cvInlineEditRuns.status, ["queued", "ready"]),
          and(eq(cvInlineEditRuns.status, "dismissed"), isNotNull(cvInlineEditRuns.proposedText))))).orderBy(desc(cvInlineEditRuns.createdAt)).limit(1);
      if (cached) {
        if (cached.status === "dismissed") {
          const [reopened] = await tx.update(cvInlineEditRuns).set({ status: "ready", updatedAt: new Date() })
            .where(eq(cvInlineEditRuns.id, cached.id)).returning();
          return { ok: true as const, run: cvInlineRunView(reopened!) };
        }
        return { ok: true as const, run: cvInlineRunView(cached) };
      }
      const opportunity = await ensureCvOpportunityForContext(tx, { userId: user.id, contextId: request.contextId });
      const id = randomUUID();
      const usage = await reserveCvAiUsage(tx, { userId: user.id, opportunityId: opportunity.opportunityId,
        operationId: id, requestKey: request.requestKey, inputHash, action: request.action,
        source: { kind: "inline_run", id }, expectedCharge: request.acceptRoleCredit ? "role_credit" : "allowance",
        expectedUnits: request.acceptRoleCredit ? 0 : CV_AI_UNITS[request.action], expectedPriceVersion: request.priceVersion });
      const [run] = await tx.insert(cvInlineEditRuns).values({ id, userId: user.id, contextId: request.contextId,
        requestKey: request.requestKey, inputHash, usageId: usage.usageId, input }).returning();
      await enqueue("edit_cv_text", { userId: user.id, runId: id }, tx);
      return { ok: true as const, run: cvInlineRunView(run!) };
    });
  } catch (error) { return failure(error); }
}

export async function readCvInlineEdit(runId: string): Promise<CvInlineResult> {
  const user = await requireUser();
  if (!uuid.test(runId)) return { ok: false, error: "Writing suggestion not found." };
  const [run] = await db().select().from(cvInlineEditRuns).where(and(eq(cvInlineEditRuns.id, runId), eq(cvInlineEditRuns.userId, user.id)));
  return run ? { ok: true, run: cvInlineRunView(run) } : { ok: false, error: "Writing suggestion not found." };
}

/** Recover one target's most recent proposal after navigation without repeating paid work. */
export async function latestCvInlineEdit(contextId: string, targetId: string, field: "text" | "signpost" = "text"): Promise<CvInlineResult> {
  const user = await requireUser();
  if (!uuid.test(contextId) || !uuid.test(targetId)) return { ok: false, error: "Writing suggestion not found." };
  const [run] = await db().select().from(cvInlineEditRuns).where(and(eq(cvInlineEditRuns.contextId, contextId),
    eq(cvInlineEditRuns.userId, user.id), sql`${cvInlineEditRuns.input}->'request'->'target'->>'id' = ${targetId}`,
    sql`${cvInlineEditRuns.input}->'request'->'target'->>'field' = ${field}`,
    inArray(cvInlineEditRuns.status, ["queued", "ready"]))).orderBy(desc(cvInlineEditRuns.createdAt)).limit(1);
  return run ? { ok: true, run: cvInlineRunView(run) } : { ok: false, error: "No pending suggestion." };
}

export async function dismissCvInlineEdit(runId: string): Promise<CvInlineResult> {
  const user = await requireUser();
  if (!uuid.test(runId)) return { ok: false, error: "Writing suggestion not found." };
  try {
    return await db().transaction(async tx => {
      const [run] = await tx.select().from(cvInlineEditRuns).where(and(eq(cvInlineEditRuns.id, runId), eq(cvInlineEditRuns.userId, user.id))).for("update");
      if (!run) throw new UserFacingError("Writing suggestion not found.");
      if (run.status === "queued") await settleCvAiUsage(tx, { usageId: run.usageId, source: { kind: "inline_run", id: run.id }, outcome: "cancelled" });
      const [updated] = await tx.update(cvInlineEditRuns).set({ status: "dismissed", updatedAt: new Date() }).where(eq(cvInlineEditRuns.id, run.id)).returning();
      return { ok: true as const, run: cvInlineRunView(updated!) };
    });
  } catch (error) { return failure(error); }
}
