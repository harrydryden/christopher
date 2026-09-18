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
import { createAiEngine, estimateCvBuildUsd, CANCELLED_ERROR, OUTPUT_LIMIT_ERROR } from "@christopher/ai";
import {
  CvContentSchema,
  CvPlanSchema,
  CvLibrarySchema,
  aiBudgetWindowStart,
  cvMaxPages,
  cvRelevanceTerms,
  groupCvLibrary,
} from "@christopher/core";
import { withResourceLease } from "../lease";
import { tryReserveAi, type AiBudgetRefusal } from "../budget";
import type { WorkerDeps } from "../context";
import { log } from "../log";

class CvDeletedError extends Error {}

type RubricSource = { jobDescription: string; assessment: { rubric: unknown } | null };

/**
 * The rubric a revision is assessed against stays fixed for its job description: the one its task
 * carries, else its parent's for the same description, else its own from an earlier assessment.
 * A parent that failed before assessing, or that the rolling archive has removed, must not cost a
 * fresh rubric that would move the goalposts between revisions.
 */
export function reusableCvRubric(draft: RubricSource, parent: RubricSource | undefined, supplied: unknown): unknown {
  return supplied ?? (parent?.jobDescription === draft.jobDescription ? parent.assessment?.rubric : undefined) ?? draft.assessment?.rubric;
}

/**
 * Why a build was not admitted, with the figures behind it, so the reader can tell a cap from a
 * fault.
 *
 * The account's own budget is the one the person who asked for the build is told about plainly: it
 * is theirs, it is monthly, and they can raise it themselves. Capacity held by their own calls in
 * flight is named when there is any, because a second build started while the first is running is
 * the ordinary way to meet it. The deployment's optional day and discovery caps are the operator's
 * and live in the worker's environment, so a refusal by one of those says so instead.
 */
function budgetRefusal(expected: number, refusal: AiBudgetRefusal): string {
  const left = Math.max(0, refusal.limitUsd - refusal.spent - refusal.held);
  const needs = `This build needs about $${expected.toFixed(2)} of AI budget;`;
  const held = refusal.held > 0 ? ` after $${refusal.held.toFixed(2)} held by calls in flight` : "";
  if (refusal.limit === "account")
    return `${needs} your budget of $${refusal.limitUsd} has $${left.toFixed(2)} left this month${held} (it resets on the 1st). Raise it on Settings, or ask an administrator.`;
  return `${needs} the deployment's ${refusal.limit === "day" ? "daily" : "discovery"} AI cap of $${refusal.limitUsd} has $${left.toFixed(2)} left${held}. An administrator can raise it in the worker's environment; then retry.`;
}
type BuildUpdate = Partial<Pick<typeof schema.cvDrafts.$inferInsert,
  "status" | "content" | "assessment" | "revision" | "buildStage" | "error" | "finalisedAt" | "progressAt">>;

/** All generation and review modes use the same immutable input snapshot and lease. */
export async function handleGenerateCv(task: Task, deps: WorkerDeps) {
  const payload = task.payload;
  if (!payload || typeof payload !== "object" || typeof payload.draftId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.draftId) ||
      (payload.mode !== undefined && payload.mode !== "assess" && payload.mode !== "improve") ||
      (payload.improvements !== undefined && (!Array.isArray(payload.improvements) || !payload.improvements.every(value => typeof value === "string")))) {
    throw new Error("Invalid CV generation task.");
  }
  const { draftId, mode, rubric: sourceRubric, improvements: sourceImprovements } = payload as {
    draftId: string;
    rubric?: Parameters<typeof validateCvRubric>[1];
    improvements?: string[];
    mode?: "assess" | "improve";
  };
  return withResourceLease(deps, `cv:${draftId}`, async (locked) => {
    const save = async (values: BuildUpdate) => {
      // Every write a live build makes is progress, so it carries the moment it happened. A build
      // that ends — ready or failed — keeps the last moment it advanced instead: `progressAt` is
      // read only to tell a slow build from a stopped one, and a finished build is neither.
      const advancing = values.status !== "ready" && values.status !== "failed";
      const patch = advancing ? { ...values, progressAt: deps.now() } : values;
      const exists = await deps.db.transaction(async (tx) => {
        await locked.assertOwnership?.(tx as unknown as Db);
        if (patch.status === "ready") return completeCv(tx, draftId, { ...patch, status: "ready" });
        const updated = await tx.update(schema.cvDrafts).set(patch)
          .where(eq(schema.cvDrafts.id, draftId)).returning({ id: schema.cvDrafts.id });
        return updated.length > 0;
      });
      if (!exists) throw new CvDeletedError();
    };
    /**
     * A stage lasts as long as its model calls, and the longest of them — writing, and each
     * assessment batch — run for minutes. Without this, a CV that reached `analysing` and then
     * died with the process was indistinguishable from one still thinking, for hours. Never
     * throws: a missed progress mark must not fail a build that is otherwise fine.
     */
    const markProgress = async () => {
      try {
        await deps.db.update(schema.cvDrafts).set({ progressAt: deps.now() })
          .where(eq(schema.cvDrafts.id, draftId));
      } catch (error) {
        log.warn("CV progress mark failed", { draftId, error: (error as Error).message });
      }
    };
    const [draft] = await deps.db
      .select()
      .from(schema.cvDrafts)
      .where(eq(schema.cvDrafts.id, draftId));
    if (!draft || draft.status === "ready") return { skipped: true };
    let phase = "preparing evidence";
    let release: (() => Promise<void>) | undefined;
    try {
      await save({ status: "generating", error: null, finalisedAt: null });
      if (!deps.env.anthropicApiKey)
        throw new Error(
          "Add ANTHROPIC_API_KEY to the worker to generate a CV.",
        );
      const library = groupCvLibrary(
        CvLibrarySchema.parse(draft.librarySnapshot),
      );
      // One hold for the whole build, at what it is expected to cost, against the budget of the
      // account that asked for it. A build that account can afford is admitted and never fails
      // part-way over budget accounting; one it cannot afford is refused here, before it spends
      // anything. Holding each call at its ceiling instead refused builds the month could plainly
      // afford, and did so after the rubric and CV had already been paid for.
      const expected = estimateCvBuildUsd(draft.model, {
        libraryBytes: Buffer.byteLength(JSON.stringify(library)),
        descriptionBytes: Buffer.byteLength(draft.jobDescription),
      });
      const account = await deps.userSettings(draft.userId);
      const hold = await tryReserveAi(deps.db, "CV", expected, {
        account: { userId: draft.userId, budgetUsd: account.aiBudgetUsd, since: aiBudgetWindowStart(deps.now(), account.aiBudgetResetAt) },
        daily: deps.env.dailyAiBudgetUsd ?? 1000000,
        discovery: deps.env.discoveryAiBudgetUsd ?? 1000000,
        workerId: deps.env.workerId,
      }, deps.now(), 30);
      if ("refused" in hold) throw new Error(budgetRefusal(expected, hold.refused));
      release = hold.release;
      const stage = async (buildStage: NonNullable<BuildUpdate["buildStage"]>) => {
        await save({ buildStage });
        await hold.renew();
      };
      let generationError: string | undefined;
      const ai = createAiEngine({
        apiKey: deps.env.anthropicApiKey,
        client: deps.aiClient,
        getModel: () => draft.model,
        onUsage: async (usage) => {
          // The failure that ended a build is the one to report: not a batch cancelled because of
          // it, and not a sibling that happened to finish cleanly afterwards.
          if (usage.error && usage.error !== CANCELLED_ERROR) generationError = usage.error;
          await deps.db.insert(schema.aiCalls).values({ ...usage, userId: draft.userId });
          // Every model call that returns — the rubric, each writing attempt, each assessment
          // batch — is the build advancing, even when the stage it belongs to does not change.
          await markProgress();
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
      await stage("analysing");
      const [parent] = draft.parentId
        ? await deps.db
            .select()
            .from(schema.cvDrafts)
            .where(eq(schema.cvDrafts.id, draft.parentId))
        : [];
      const rubric = validateCvRubric(
        draft.jobDescription,
        (reusableCvRubric(draft, parent, sourceRubric) as Parameters<typeof validateCvRubric>[1] | undefined) ??
          requireResult(
            await ai.analyseCvJob(draft.jobDescription, {
              refType: "cv-rubric",
              refId: draft.id,
              userId: draft.userId,
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
        // Saved wording that no longer fits is refitted; a rebuild starts from the Library.
        const initial = content ? CvPlanSchema.parse(content) : undefined;
        const writingLibrary = content
          ? { ...library, theme: content.theme ?? library.theme }
          : library;
        const improvements =
          mode === "improve"
            ? (sourceImprovements ?? parent?.assessment?.review.matches
                .filter((match) => cvImprovementOwner(match) === "system")
                .map((match) => match.improvement) ?? []).filter(Boolean)
            : undefined;
        // Relevance uses the company's criteria, weighted as the assessment weights them.
        const target = cvRelevanceTerms(rubric.requirements);
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
                { refType: "cv-author", refId: draft.id, userId: draft.userId },
              ),
            ),
          initial,
          stage,
        );
        // Retain a recoverable draft if the later assessment call fails.
        await save({ content });
      }
      phase = "assessing the final wording and factual evidence";
      await stage("assessing");
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
          { refType: "cv-review", refId: draft.id, userId: draft.userId },
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
    } finally {
      await release?.();
    }
  });
}
