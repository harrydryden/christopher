import { buildFittedCv } from "@christopher/core/cv-fit";
import { renderCvPdfWithReport } from "@christopher/core/cv-pdf";
import {
  createCvAssessment,
  validateCvRubric,
} from "@christopher/core/cv-review";
import {
  cvTextItems,
  cvClaimItems,
  cvEvidenceItems,
  cvImprovementOwner,
} from "@christopher/core/cv-assessment";
import { eq } from "drizzle-orm";
import { schema, type Task, type Db } from "@christopher/db";
import { createAiEngine, OUTPUT_LIMIT_ERROR } from "@christopher/ai";
import {
  CvContentSchema,
  CvPlanSchema, CvLibrarySchema, groupCvLibrary } from "@christopher/core";
import { withResourceLease } from "../lease";
import { reserveAi } from "../budget";
import { aiSpendThisMonth, type WorkerDeps } from "../context";

/** All generation and review modes use the same immutable input snapshot and lease. */
export async function handleGenerateCv(task: Task, deps: WorkerDeps) {
  const { draftId, sourcePlan, mode } = task.payload as { draftId: string;
    sourcePlan?: unknown;
    mode?: "assess" | "improve";
  };
  return withResourceLease(deps, `cv:${draftId}`, async (locked) => {
    const save = async (values: Partial<typeof schema.cvDrafts.$inferInsert>) =>
      deps.db.transaction(async (tx) => {
        await locked.assertOwnership?.(tx as unknown as Db);
        await tx
          .update(schema.cvDrafts)
          .set(values)
          .where(eq(schema.cvDrafts.id, draftId));
      });
    const [draft] = await deps.db
      .select()
      .from(schema.cvDrafts)
      .where(eq(schema.cvDrafts.id, draftId));
    if (!draft || draft.status === "ready") return { skipped: true };
    await save({ status: "generating", error: null, finalisedAt: null });
    let phase = "preparing evidence";
    try {
      if (!deps.env.anthropicApiKey)
        throw new Error(
          "Add ANTHROPIC_API_KEY to the worker to generate a CV.",
        );
      if (
        (await aiSpendThisMonth(deps.db, deps.now())) >=
        (await deps.settings()).monthlyAiBudgetUsd
      )
        throw new Error(
          "Monthly AI budget reached. Update the budget in Settings, then retry.",
        );
      const library = groupCvLibrary(
        CvLibrarySchema.parse(draft.librarySnapshot),
      );
      let generationError: string | undefined;
      const ai = createAiEngine({
        reserve: async (callSite, amount) =>
          reserveAi(deps.db, callSite, amount, {
            monthly: (await deps.settings()).monthlyAiBudgetUsd,
            daily: deps.env.dailyAiBudgetUsd ?? 1000000,
            discovery: deps.env.discoveryAiBudgetUsd ?? 1000000,
          }),
        apiKey: deps.env.anthropicApiKey,
        getModel: () => draft.model,
        onUsage: async (usage) => {
          generationError = usage.error;
          await deps.db.insert(schema.aiCalls).values(usage);
        },
      });
      const requireResult = <T>(value: T | null): T => {
        if (value) return value;
        if (generationError === OUTPUT_LIMIT_ERROR)
          throw new Error(
            "The model reached its output limit. Retry or select a more capable CV model.",
          );
        throw new Error(
          "The model did not return a valid result. Check model access and usage in Health, then retry.",
        );
      };
      phase = "analysing the company job description";
      const [parent] = draft.parentId
        ? await deps.db
            .select()
            .from(schema.cvDrafts)
            .where(eq(schema.cvDrafts.id, draft.parentId))
        : [];
      // Keep the rubric fixed across revisions: improvements cannot move the goalposts.
      const reusable =
        parent?.jobDescription === draft.jobDescription
          ? parent.assessment?.rubric
          : draft.assessment?.rubric;
      const rubric = validateCvRubric(
        draft.jobDescription,
        reusable ??
          requireResult(
            await ai.analyseCvJob(draft.jobDescription, {
              refType: "cv-rubric",
              refId: draft.id,
            }),
          ),
      );
      let content;
      if (mode === "assess" && draft.content) {
        content = CvContentSchema.parse(draft.content);
      } else {
        phase = "writing and fitting the CV";
        const initial = sourcePlan ? CvPlanSchema.parse(sourcePlan) : undefined;
        const improvements =
          mode === "improve"
            ? parent?.assessment?.review.matches
                .filter((match) => cvImprovementOwner(match) === "system")
                .map((match) => match.improvement)
            : undefined;
        // Relevance uses the company's criteria, excluding benefits and employer boilerplate.
        const target = rubric.requirements
          .map((item) => `${item.label} ${item.quote}`)
          .join("\n");
        content = await buildFittedCv(
          library,
          target,
          async (input) =>
            requireResult(
              await ai.buildCv(
                {
                  library,
                  jobTitle: draft.jobTitle,
                  company: draft.companyName,
                  description: draft.jobDescription,
                  rubric,
                  improvements,
                  ...input,
                },
                { refType: "cv-author", refId: draft.id },
              ),
            ),
          initial,
        );
        // Retain a recoverable draft if the later assessment call fails.
        await save({ content });
      }
      phase = "assessing the final wording and factual evidence";
      const { pageCount } = await renderCvPdfWithReport(content);
      const review = requireResult(
        await ai.assessCv(
          {
            rubric,
            cv: cvTextItems(content),
            claims: cvClaimItems(content),
            evidence: cvEvidenceItems(library),
          },
          { refType: "cv-review", refId: draft.id },
        ),
      );
      const assessment = createCvAssessment({
        content,
        description: draft.jobDescription,
        library,
        rubric,
        review,
        model: draft.model,
        pageCount,
        now: deps.now(),
      });
      await save({
        status: "ready",
        content,
        assessment,
        revision: Math.max(1, draft.revision),
      });
      return { draftId, ready: true };
    } catch (error) {
      const message = `${phase}: ${error instanceof Error ? error.message : "CV generation failed"}`;
      await save({ status: "failed", error: message.slice(0, 1000) });
      return { draftId, failed: true, error: message };
    }
  });
}
