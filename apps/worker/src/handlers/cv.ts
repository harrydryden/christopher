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
import { accountAiSpend, completeCv, schema, type Task, type Db } from "@christopher/db";
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
import { aiSpendThisMonth, type WorkerDeps } from "../context";
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
 * Why a build was not admitted against this account's own budget.
 *
 * The account budget is the one the person who asked for the build can be told about plainly: it
 * is theirs, it is monthly, and an administrator raises it per account. Work in flight is not
 * named here because an account's builds are serialised by the draft lease; the shared refusal
 * below is the one that has to explain held capacity.
 */
function accountBudgetRefusal(expected: number, budgetUsd: number, spent: number): string {
  const left = Math.max(0, budgetUsd - spent);
  return `This build needs about $${expected.toFixed(2)} of AI budget; your budget of $${budgetUsd} has $${left.toFixed(2)} left this month (it resets on the 1st). An administrator can raise it in Admin › Accounts.`;
}

/** Why a build was not admitted, with the figures behind it, so the reader can tell a cap from a fault. */
function budgetRefusal(expected: number, refusal: AiBudgetRefusal): string {
  const name = refusal.limit === "month" ? "monthly" : refusal.limit === "day" ? "daily" : "discovery";
  const left = Math.max(0, refusal.limitUsd - refusal.spent - refusal.held);
  const where = refusal.limit === "month" ? "in Admin › System settings" : "in the worker's environment";
  return `This build needs about $${expected.toFixed(2)} of AI budget; the shared ${name} budget of $${refusal.limitUsd} has $${left.toFixed(2)} left` +
    (refusal.held > 0 ? ` after $${refusal.held.toFixed(2)} held by work in flight` : "") +
    `. An administrator can raise it ${where}; then retry.`;
}
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
  const { draftId, mode, rubric: sourceRubric, improvements: sourceImprovements } = payload as {
    draftId: string;
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
    let release: (() => Promise<void>) | undefined;
    try {
      await save({ status: "generating", error: null, finalisedAt: null });
      if (!deps.env.anthropicApiKey)
        throw new Error(
          "Add ANTHROPIC_API_KEY to the worker to generate a CV.",
        );
      const settings = await deps.settings();
      const spent = await aiSpendThisMonth(deps.db, deps.now(), settings.aiBudgetResetAt);
      if (spent >= settings.monthlyAiBudgetUsd)
        throw new Error(
          `Shared monthly AI budget reached: $${spent.toFixed(2)} of $${settings.monthlyAiBudgetUsd} is spent. An administrator can raise it in Admin › System settings; then retry.`,
        );
      const library = groupCvLibrary(
        CvLibrarySchema.parse(draft.librarySnapshot),
      );
      // One hold for the whole build, at what it is expected to cost. A build the month can afford
      // is admitted and never fails part-way over budget accounting; one it cannot afford is refused
      // here, before it spends anything. Holding each call at its ceiling instead refused builds
      // the month could plainly afford, and did so after the rubric and CV had already been paid for.
      const expected = estimateCvBuildUsd(draft.model, {
        libraryBytes: Buffer.byteLength(JSON.stringify(library)),
        descriptionBytes: Buffer.byteLength(draft.jobDescription),
      });
      // The account's own budget first: it is this person's monthly allowance, so a build they
      // cannot afford is refused here, before the shared capacity is held and before anything is
      // spent. The shared ceiling below then covers the deployment, this build included.
      const account = await deps.userSettings(draft.userId);
      const accountSpent = await accountAiSpend(deps.db, draft.userId, aiBudgetWindowStart(deps.now(), account.aiBudgetResetAt));
      if (accountSpent + expected > account.aiBudgetUsd)
        throw new Error(accountBudgetRefusal(expected, account.aiBudgetUsd, accountSpent));
      const hold = await tryReserveAi(deps.db, "CV", expected, {
        monthly: settings.monthlyAiBudgetUsd,
        daily: deps.env.dailyAiBudgetUsd ?? 1000000,
        discovery: deps.env.discoveryAiBudgetUsd ?? 1000000,
        resetAt: settings.aiBudgetResetAt,
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
