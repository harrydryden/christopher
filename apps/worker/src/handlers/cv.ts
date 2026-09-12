import { renderCvPdfWithReport, assertCvPageLimit, CV_MAX_PAGES } from "@christopher/core/cv-pdf";
import { eq } from "drizzle-orm";
import { schema, type Task, type Db } from "@christopher/db";
import { createAiEngine, OUTPUT_LIMIT_ERROR } from "@christopher/ai";
import { materialiseCv, CvLibrarySchema, groupCvLibrary } from "@christopher/core";
import { withResourceLease } from "../lease";
import { reserveAi } from "../budget";
import { aiSpendThisMonth, type WorkerDeps } from "../context";

export async function handleGenerateCv(task: Task, deps: WorkerDeps) {
  const { draftId } = task.payload as { draftId: string };
  // Retried or recovered queue tasks must not race or overwrite a completed draft.
  return withResourceLease(deps, `cv:${draftId}`, async locked => {
    const save = async (values: Partial<typeof schema.cvDrafts.$inferInsert>) => deps.db.transaction(async tx => {
      await locked.assertOwnership?.(tx as unknown as Db);
      await tx.update(schema.cvDrafts).set(values).where(eq(schema.cvDrafts.id, draftId));
    });
    const [draft] = await deps.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draftId));
    if (!draft || draft.status === "ready") return { skipped: true };
    await save({ status: "generating", error: null });
    try {
      if (!deps.env.anthropicApiKey) throw new Error("Add ANTHROPIC_API_KEY to the worker to generate a CV.");
      if (await aiSpendThisMonth(deps.db, deps.now()) >= (await deps.settings()).monthlyAiBudgetUsd) throw new Error("Monthly AI budget reached. Update the budget in Settings, then generate again.");
      const library = groupCvLibrary(CvLibrarySchema.parse(draft.librarySnapshot));
      let generationError: string | undefined;
      const ai = createAiEngine({ reserve: async (callSite, amount) => reserveAi(deps.db, callSite, amount, {
        monthly: (await deps.settings()).monthlyAiBudgetUsd, daily: deps.env.dailyAiBudgetUsd ?? 1000000, discovery: deps.env.discoveryAiBudgetUsd ?? 1000000,
      }), apiKey: deps.env.anthropicApiKey, getModel: () => draft.model,
        onUsage: async usage => { generationError = usage.error; await deps.db.insert(schema.aiCalls).values(usage); } });
      let feedback: Parameters<typeof ai.buildCv>[0]["layoutFeedback"];
      let requiredEntries: string[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const plan = await ai.buildCv({ library, jobTitle: draft.jobTitle, company: draft.companyName, description: draft.jobDescription, ...(feedback ? { layoutFeedback: feedback } : {}) }, { refType: "cv", refId: draft.id });
        if (!plan && generationError === OUTPUT_LIMIT_ERROR) throw new Error("The model reached its output limit before completing your CV. Generate again, or select a different CV model in Settings.");
        if (!plan) throw new Error("Anthropic did not return a valid CV. Check the model and API details in Health, then generate again.");
        const content = materialiseCv(library, plan);
        if (requiredEntries.some(id => !content.sections.some(section => section.entryId === id))) throw new Error("The shortened CV omitted an employment or education entry. Generate again; no incomplete CV was saved.");
        requiredEntries = content.sections.filter(section => section.kind === "experience" || section.kind === "education").map(section => section.entryId);
        const { pageCount } = await renderCvPdfWithReport(content);
        if (pageCount <= CV_MAX_PAGES) {
          await save({ status: "ready", content, revision: 1 });
          return { draftId, ready: true };
        }
        if (attempt === 2) assertCvPageLimit(pageCount);
        feedback = { pageCount, maxPages: CV_MAX_PAGES, previousPlan: plan };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "CV generation failed";
      await save({ status: "failed", error: message.slice(0, 1000) });
      return { draftId, failed: true, error: message };
    }
  });
}
