/** Propose, never save, one answer's grounded Experience wording. */
import { and, eq } from "drizzle-orm";
import { validateEvidenceDraft, type TaskPayloads } from "@col/core";
import { estimateEvidenceDraftUsd } from "@col/ai";
import { evidenceDrafts, latestCvLibrary, type Db, type Task } from "@col/db";
import { openAccountAiPass } from "../account-ai-pass";
import type { WorkerDeps } from "../context";
import type { TaskRunContext } from "../queue";

export async function handleDraftEvidence(task: Task, deps: WorkerDeps, ctx?: TaskRunContext): Promise<unknown> {
  const { userId, evidenceDraftId, attempt } = (task.payload ?? {}) as TaskPayloads["draft_evidence"];
  if (!userId || !evidenceDraftId || !attempt) return { skipped: "invalid draft task" };
  const [draft] = await deps.db.select().from(evidenceDrafts)
    .where(and(eq(evidenceDrafts.id, evidenceDraftId), eq(evidenceDrafts.userId, userId))).limit(1);
  if (!draft || draft.status !== "queued" || draft.attempt !== attempt) return { skipped: "draft superseded" };

  const finish = async (outcome: { status: "drafted" | "failed"; wording?: string | null; quotes?: string[] | null; error?: string | null }) => {
    const written = await deps.db.transaction(async tx => {
      await deps.assertOwnership?.(tx as unknown as Db);
      return tx.update(evidenceDrafts).set({
        status: outcome.status, wording: outcome.wording ?? null,
        supportingQuotes: outcome.quotes ?? null, error: outcome.error ?? null, updatedAt: deps.now(),
      }).where(and(eq(evidenceDrafts.id, draft.id), eq(evidenceDrafts.userId, userId),
        eq(evidenceDrafts.attempt, attempt), eq(evidenceDrafts.status, "queued"))).returning({ id: evidenceDrafts.id });
    });
    if (!written.length) return { skipped: "draft resolved or superseded" };
    return { status: outcome.status, ...(outcome.error ? { message: outcome.error } : {}) };
  };

  const latest = await latestCvLibrary(deps.db, userId);
  if ((latest?.version ?? 0) !== draft.input.baseVersion)
    return finish({ status: "failed", error: "Your Experience changed. Review the latest version before drafting again." });
  const settings = await deps.userSettings(userId);
  const model = settings.cvModel;
  const pass = openAccountAiPass(deps, { userId, settings, callSite: "A13", model, refId: `evidence_draft:${draft.id}`, signal: ctx?.signal });
  if (!pass.ai.enabled)
    return finish({ status: "failed", error: "Drafting is unavailable now. You can use your answer as written." });
  const admitted = await pass.admit(estimateEvidenceDraftUsd(model, Buffer.byteLength(draft.input.answer)));
  if ("refused" in admitted) return finish({ status: "failed", error: `${admitted.refused} You can use your answer as written.` });
  let proposed: Awaited<ReturnType<typeof pass.ai.draftEvidence>>;
  try {
    proposed = await pass.ai.draftEvidence(draft.input,
      { userId, refType: "evidence_draft", refId: draft.id }, model);
  } catch (error) {
    if (ctx?.signal.aborted) throw error;
    return finish({ status: "failed", error: "Drafting stopped before a proposal was ready. Retry or use your answer as written." });
  } finally {
    await admitted.release();
  }
  if (ctx?.signal.aborted) throw new Error("Evidence draft stopped before the model answered.");
  if (!proposed) return finish({ status: "failed", error: "No safe wording was returned. Try again or use your answer as written." });
  const grounded = validateEvidenceDraft(draft.input, proposed);
  if (!grounded) return finish({ status: "failed", error: "The proposed wording added a claim your answer did not support. Use your answer as written or try again with more detail." });
  const stillLatest = await latestCvLibrary(deps.db, userId);
  if ((stillLatest?.version ?? 0) !== draft.input.baseVersion)
    return finish({ status: "failed", error: "Your Experience changed while drafting. Review the latest version before saving." });
  return finish({ status: "drafted", wording: grounded.wording, quotes: grounded.quotes });
}
