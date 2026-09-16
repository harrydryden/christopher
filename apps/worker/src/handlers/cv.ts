import { buildFittedCv } from "@christopher/core/cv-fit";
import {
  renderCvPdfWithReport,
  assertCvPageLimit,
  CvLayoutError,
} from "@christopher/core/cv-pdf";
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
import { completeCv, schema, type Task, type Db } from "@christopher/db";
import { createAiEngine, OUTPUT_LIMIT_ERROR } from "@christopher/ai";
import {
  CvContentSchema,
  CvPlanSchema,
  CvLibrarySchema,
  cvMaxPages,
  groupCvLibrary,
} from "@christopher/core";
import { withResourceLease } from "../lease";
import { reserveAi } from "../budget";
import { aiSpendThisMonth, type WorkerDeps } from "../context";
import { log } from "../log";

class CvDeletedError extends Error {}
type BuildUpdate = Partial<Pick<typeof schema.cvDrafts.$inferInsert,
  "status" | "content" | "assessment" | "revision" | "buildStage" | "error" | "finalisedAt">>;

/** All generation and review modes use the same immutable input snapshot and lease. */
export async function handleGenerateCv(task: Task, deps: WorkerDeps) {
  const payload = task.payload;
  if (!payload || typeof payload !== "object" || typeof payload.draftId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.draftId) ||
      (payload.mode !== undefined && payload.mode !== "assess" && payload.mode !== "improve") ||
      (payload.improvements !== undefined && (!Array.isArray(payload.improvements) || !payload.improvements.every(value => typeof value === "string")))) {
    throw new Error("Invalid CV generation task.");
  }
  if (payload.sourcePlan !== undefined && !CvPlanSchema.safeParse(payload.sourcePlan).success)
    throw new Error("Invalid CV source plan.");
  const { draftId, sourcePlan, mode, rubric: sourceRubric, improvements: sourceImprovements } = payload as {
    draftId: string;
    sourcePlan?: unknown;
    rubric?: Parameters<typeof validateCvRubric>[1];
    improvements?: string[];
    mode?: "assess" | "improve";
  };
  return withResourceLease(deps, `cv:${draftId}`, async (locked) => {
    const save = async (values: BuildUpdate) => {
      const exists = await deps.db.transaction(async (tx) => {
        await locked.assertOwnership?.(tx as unknown as Db);
        if (values.status === "ready") return completeCv(tx, draftId, { ...values, status: "ready" });
        const updated = await tx.update(schema.cvDrafts).set(values)
          .where(eq(schema.cvDrafts.id, draftId)).returning({ id: schema.cvDrafts.id });
        return updated.length > 0;
      });
      if (!exists) throw new CvDeletedError();
    };
    const [draft] = await deps.db
      .select()
      .from(schema.cvDrafts)
      .where(eq(schema.cvDrafts.id, draftId));
    if (!draft || draft.status === "ready") return { skipped: true };
    let phase = "preparing evidence";
    try {
      await save({ status: "generating", error: null, finalisedAt: null });
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
        if (generationError && /timed? out|timeout/i.test(generationError))
          throw new Error("The model took too long to respond. Your saved CV is preserved; retry its assessment or build.");
        throw new Error(
          "The model did not return a valid result. Check model access and usage in Health, then retry.",
        );
      };
      phase = "analysing the company job description";
      await save({ buildStage: "analysing" });
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
        sourceRubric ?? reusable ??
          requireResult(
            await ai.analyseCvJob(draft.jobDescription, {
              refType: "cv-rubric",
              refId: draft.id,
            }),
          ),
      );
      let content =
        mode === "assess" && draft.content
          ? CvContentSchema.parse(draft.content)
          : undefined;
      // Old drafts and manual edits must meet the same measured layout gate as fresh writing.
      const savedPages = content
        ? await renderCvPdfWithReport(content)
            .then((report) => report.pageCount)
            .catch((error) => {
              if (error instanceof CvLayoutError) return Number.POSITIVE_INFINITY;
              throw error;
            })
        : undefined;
      // Each saved revision carries its own page limit in its theme.
      if (!content || savedPages! > cvMaxPages(content.theme)) {
        phase = "writing and fitting the CV";
        const initial = content
          ? CvPlanSchema.parse(content)
          : sourcePlan
            ? CvPlanSchema.parse(sourcePlan)
            : undefined;
        const writingLibrary = content
          ? { ...library, theme: content.theme ?? library.theme }
          : library;
        const improvements =
          mode === "improve"
            ? sourceImprovements ?? parent?.assessment?.review.matches
                .filter((match) => cvImprovementOwner(match) === "system")
                .map((match) => match.improvement)
            : undefined;
        // Relevance uses the company's criteria, excluding benefits and employer boilerplate.
        const target = rubric.requirements
          .map((item) => `${item.label} ${item.quote}`)
          .join("\n");
        content = await buildFittedCv(
          writingLibrary,
          target,
          async (input) =>
            requireResult(
              await ai.buildCv(
                {
                  library: writingLibrary,
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
          async (stage) => {
            await save({ buildStage: stage });
          },
        );
        // Retain a recoverable draft if the later assessment call fails.
        await save({ content });
      }
      phase = "assessing the final wording and factual evidence";
      await save({ buildStage: "assessing" });
      const { pageCount, maxPages } = await renderCvPdfWithReport(content);
      assertCvPageLimit(pageCount, maxPages);
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
        buildStage: null,
        content,
        assessment,
        revision: Math.max(1, draft.revision),
      });
      return { draftId, ready: true };
    } catch (error) {
      if (error instanceof CvDeletedError) return { draftId, skipped: true, reason: "deleted" };
      const detail = error instanceof Error && !error.message.startsWith("Failed query:")
        ? error.message : "Could not complete this CV. Please retry.";
      const message = `${phase}: ${detail}`;
      log.warn("CV generation failed", { draftId, phase });
      try {
        await save({ status: "failed", error: message.slice(0, 1000), buildStage: null });
      } catch (saveError) {
        if (saveError instanceof CvDeletedError) return { draftId, skipped: true, reason: "deleted" };
        throw saveError;
      }
      return { draftId, failed: true, error: message };
    }
  });
}
