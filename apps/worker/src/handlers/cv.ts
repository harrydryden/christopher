import { eq, sql } from "drizzle-orm";
import { schema, type Task, type Db } from "@christopher/db";
import { createAiEngine } from "@christopher/ai";
import { materialiseCv, CvLibrarySchema } from "@christopher/core";
import { aiSpendThisMonth, type WorkerDeps } from "../context";

export async function handleGenerateCv(task: Task, deps: WorkerDeps) {
  const { draftId } = task.payload as { draftId: string };
  // Retried or recovered queue tasks must not race or overwrite a completed draft.
  return deps.db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cv:${draftId}`}))`);
    const [draft] = await tx.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draftId));
    if (!draft || draft.status === "ready") return { skipped: true };
    await tx.update(schema.cvDrafts).set({ status: "generating", error: null }).where(eq(schema.cvDrafts.id, draftId));
    try {
      if (!deps.env.anthropicApiKey) throw new Error("Add ANTHROPIC_API_KEY to the worker to generate a CV.");
      if (await aiSpendThisMonth(tx as unknown as Db, deps.now()) >= (await deps.settings()).monthlyAiBudgetUsd) throw new Error("Monthly AI budget reached. Update the budget in Settings, then generate again.");
      const library = CvLibrarySchema.parse(draft.librarySnapshot);
      const ai = createAiEngine({ apiKey: deps.env.anthropicApiKey, getModel: () => draft.model,
        onUsage: async usage => { await tx.insert(schema.aiCalls).values(usage); } });
      const plan = await ai.buildCv({ library, jobTitle: draft.jobTitle, company: draft.companyName, description: draft.jobDescription }, { refType: "cv", refId: draft.id });
      if (!plan) throw new Error("Anthropic did not return a valid CV. Check the model and API details in Health, then generate again.");
      await tx.update(schema.cvDrafts).set({ status: "ready", content: materialiseCv(library, plan), revision: 1 }).where(eq(schema.cvDrafts.id, draftId));
      return { draftId, ready: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "CV generation failed";
      await tx.update(schema.cvDrafts).set({ status: "failed", error: message.slice(0, 1000) }).where(eq(schema.cvDrafts.id, draftId));
      return { draftId, failed: true, error: message };
    }
  });
}
