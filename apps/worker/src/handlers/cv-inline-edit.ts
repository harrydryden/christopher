import { and, eq } from "drizzle-orm";
import type { TaskPayloads } from "@col/core";
import { validateCvInlineProposal } from "@col/core/cv-inline-ai";
import { estimateCostUsd } from "@col/ai";
import { PROMPTS } from "@col/ai/prompt-registry";
import { careerHeads, cvInlineEditRuns, cvInlineSourceCurrent, settleCvAiUsage, type Db, type Task } from "@col/db";
import { openAccountAiPass } from "../account-ai-pass";
import type { WorkerDeps } from "../context";
import type { TaskRunContext } from "../queue";

const unavailable = "Writing help stopped before a suggestion was ready. Your wording has not changed. Try again.";

export async function handleEditCvText(task: Task, deps: WorkerDeps, ctx?: TaskRunContext): Promise<unknown> {
  const { userId, runId } = (task.payload ?? {}) as TaskPayloads["edit_cv_text"];
  if (!userId || !runId) return { skipped: "invalid edit request" };
  const [run] = await deps.db.select().from(cvInlineEditRuns).where(and(eq(cvInlineEditRuns.id, runId), eq(cvInlineEditRuns.userId, userId)));
  if (!run || run.status !== "queued") return { skipped: "edit already settled" };
  const current = async (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => {
    if (!await cvInlineSourceCurrent(tx, userId, run.input)) return false;
    if (run.input.request.action === "inline_tailor") {
      const [head] = await tx.select().from(careerHeads).where(eq(careerHeads.userId, userId)).for("share");
      if (head?.revision !== run.input.careerVersion) return false;
    }
    return true;
  };
  const finish = async (proposal: string | null, error: string | null = null) => deps.db.transaction(async tx => {
    await deps.assertOwnership?.(tx as unknown as Db);
    // Context/source before run before billing, matching admission. Never hold a lock over a provider call.
    if (proposal !== null && !await current(tx)) { proposal = null; error = "This CV, role or Experience changed. Ask for a new suggestion."; }
    const [locked] = await tx.select().from(cvInlineEditRuns).where(and(eq(cvInlineEditRuns.id, run.id), eq(cvInlineEditRuns.userId, userId))).for("update");
    if (!locked || locked.status !== "queued") return { skipped: "edit already settled" };
    const status = proposal === null ? "failed" as const : "ready" as const;
    await tx.update(cvInlineEditRuns).set({ status, proposedText: proposal, error, updatedAt: deps.now() }).where(eq(cvInlineEditRuns.id, run.id));
    await settleCvAiUsage(tx, { usageId: run.usageId, source: { kind: "inline_run", id: run.id }, outcome: status });
    return { status };
  });
  if (run.input.promptVersion !== PROMPTS["cv.inline_edit"].version || run.input.verifierVersion !== PROMPTS["cv.inline_verify"].version)
    return finish(null, "Writing help was updated. Ask for a new suggestion.");
  if (!await deps.db.transaction(current)) return finish(null, "This CV, role or Experience changed. Ask for a new suggestion.");
  const settings = await deps.userSettings(userId);
  const pass = openAccountAiPass(deps, { userId, settings, callSite: "CV", model: run.input.model,
    refId: `cv_inline:${run.id}`, signal: ctx?.signal, stageRoutes: run.input.routes });
  if (!pass.ai.enabled) return finish(null, unavailable);
  const size = run.input.selection.selected.length + run.input.role.length + JSON.stringify(run.input.evidence).length + 3_000;
  const expected = (["cv.inline_edit", "cv.inline_verify"] as const).reduce((cost, id) => cost + estimateCostUsd(
    run.input.routes[id]?.model ?? run.input.model, { inputTokens: Math.ceil(size / 2),
      outputTokens: PROMPTS[id].maxTokens, cacheReadTokens: 0, cacheWriteTokens: 0 }), 0);
  const admitted = await pass.admit(expected);
  // Private provider/budget failures remain in operations, never in a customer's suggestion panel.
  if ("refused" in admitted) return finish(null, unavailable);
  try {
    const raw = await pass.ai.editCvText(run.input, { userId, refType: "cv_inline", refId: run.id });
    const proposal = validateCvInlineProposal(run.input, raw);
    if (proposal === null) return finish(null, unavailable);
    const verified = await pass.ai.verifyCvTextEdit(run.input, proposal, { userId, refType: "cv_inline", refId: run.id });
    if (!verified?.preservesFacts || !verified.followsAction) return finish(null, "The suggestion changed the meaning of your text. Your wording has been kept. Try again.");
    if (ctx?.signal.aborted) throw new Error("Edit interrupted");
    return finish(proposal);
  } catch (error) {
    if (ctx?.signal.aborted) throw error;
    return finish(null, unavailable);
  } finally { await admitted.release(); }
}

/** Called only after queue retries end; successful proposals and cancellations are left intact. */
export async function abandonCvInlineEdit(task: Pick<Task, "payload">, deps: Pick<WorkerDeps, "db" | "now">): Promise<void> {
  const { userId, runId } = (task.payload ?? {}) as TaskPayloads["edit_cv_text"];
  if (!userId || !runId) return;
  await deps.db.transaction(async tx => {
    const [run] = await tx.select().from(cvInlineEditRuns).where(and(eq(cvInlineEditRuns.id, runId), eq(cvInlineEditRuns.userId, userId))).for("update");
    if (!run || run.status !== "queued") return;
    await tx.update(cvInlineEditRuns).set({ status: "failed", error: unavailable, updatedAt: deps.now() }).where(eq(cvInlineEditRuns.id, runId));
    await settleCvAiUsage(tx, { usageId: run.usageId, source: { kind: "inline_run", id: run.id }, outcome: "failed" });
  });
}
