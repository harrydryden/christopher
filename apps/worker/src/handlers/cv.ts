import { buildFittedCv, selectCvToFit, CvFitFailure, type CvFitEvent } from "@ava/core/cv-fit";
import {
  renderCvPdfWithReport,
  assertCvPageLimit,
  CvLayoutError,
} from "@ava/core/cv-pdf";
import {
  createCvAssessment,
  cvAssessmentCurrent,
  validateCvRubric,
} from "@ava/core/cv-review";
import {
  cvTextItems,
  cvClaimItems,
  cvEvidenceItems,
  cvImprovementOwner,
  type CvAssessment,
  type CvReviewPlan,
} from "@ava/core/cv-assessment";
import { cvTailoringEvidence, validateCvTailoringPlan } from "@ava/core/cv-tailoring";
import { buildCvGapQuiz } from "@ava/core/cv-gap-quiz";
import { compareCvQuality, diagnoseCvQuality } from "@ava/core/cv-quality";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { completeCv, cvRoleKey, schema, type Task, type Db } from "@ava/db";
import { createAiEngine, estimateCvBuildUsd, CANCELLED_ERROR, DEADLINE_ERROR_PREFIX, INTERRUPTED_ERROR_PREFIX, type AiFailure, type AiUsageRecord } from "@ava/ai";
import {
  CvContentSchema,
  CvPlanSchema,
  CvLibrarySchema,
  CV_BUILD_MOTIONS,
  CV_BUILD_STAGES,
  aiBudgetRefusalMessage,
  aiBudgetWindowStart,
  assessmentTally,
  callCost,
  cvMaxPages,
  cvRelevanceTerms,
  createCvWritingBudget,
  groupCvLibrary,
  reusedCvRubric,
  usd,
  type CvBuildCheckpoint,
  type CvFailureKind,
} from "@ava/core";
import {
  AUTHOR_CALL,
  callFailureMessage,
  CV_LOST_PLACE_MESSAGE,
  CvBuildStop,
  cvBuildFailureFor,
  REVIEW_CALL,
  RUBRIC_CALL,
  type CvCallDoing,
} from "@ava/core/cv-build-failure";
import { withResourceLease } from "../lease";
import { recordAiUsage, tryReserveAi, type AiHold } from "../budget";
import { backoffMs, type TaskRunContext } from "../queue";
import { CvJournal, type CvJournalLoss, type CvOpenStep } from "./cv-journal";
import type { WorkerDeps } from "../context";
import { log } from "../log";

class CvDeletedError extends Error {}

export { CvBuildStop };

/**
 * Thrown when the system is going to resolve the failure itself: the queue re-queues the task with
 * its usual backoff, and the next attempt resumes from the build's checkpoint rather than paying
 * for the rubric and the writing again. The draft stays `generating` with `failure` explaining
 * the wait, so the page says what happened and when it will be tried again.
 *
 * It carries no more than its message: the failure itself is on the draft, which is where the page
 * reads it, and a second copy on the error was one the queue never looked at.
 */
export class CvRetryableBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CvRetryableBuildError";
  }
}

/** What someone is told when another worker still holds this build's lease. */
export const CV_BUSY_MESSAGE = "Another worker is still finishing this build";

/** What the person is told when the budget stopped holding capacity for a build still running. */
export const CV_HOLD_LOST_MESSAGE =
  "This build's share of your AI budget was released while it was running, so it stopped rather than spend more.";

type BuildUpdate = Partial<Pick<typeof schema.cvDrafts.$inferInsert,
  "status" | "content" | "assessment" | "revision" | "buildStage" | "error" | "finalisedAt" | "progressAt" | "buildCheckpoint" | "failure" | "gapQuiz">>;

/** The four milestones the draft carries for the page's strip. */
type BuildStage = NonNullable<BuildUpdate["buildStage"]>;
/** The motions the fitter reports, whose milestones are always two of those four. */
type FitMotion = CvFitEvent["motion"] | "rewrite";

/** Whether publishing this build will archive a CV that is currently the saved one for its role. */
async function archivesPrevious(db: Db, draft: { id: string; userId: string; companyName: string; jobTitle: string }): Promise<boolean> {
  const rows = await db.select({ id: schema.cvDrafts.id }).from(schema.cvDrafts).where(and(
    sql`${cvRoleKey(schema.cvDrafts.userId, schema.cvDrafts.companyName, schema.cvDrafts.jobTitle)} = ${cvRoleKey(draft.userId, draft.companyName, draft.jobTitle)}`,
    eq(schema.cvDrafts.status, "ready"), isNull(schema.cvDrafts.archivedAt), ne(schema.cvDrafts.id, draft.id),
  )).limit(1);
  return rows.length > 0;
}

/** A second or third writing attempt is a rewrite: the catalogue has the motion, so the ledger uses it. */
function writingMotion(attempt: number): "write" | "rewrite" {
  return attempt > 1 ? "rewrite" : "write";
}

/** All generation and review modes use the same immutable input snapshot and lease. */
export async function handleGenerateCv(task: Task, deps: WorkerDeps, ctx?: TaskRunContext) {
  const payload = task.payload;
  if (!payload || typeof payload !== "object" || typeof payload.draftId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.draftId) ||
      (payload.mode !== undefined && payload.mode !== "assess" && payload.mode !== "improve") ||
      (payload.improvements !== undefined && (!Array.isArray(payload.improvements) || !payload.improvements.every(value => typeof value === "string")))) {
    throw new Error("Invalid CV generation task.");
  }
  const { draftId, mode: requestedMode, rubric: suppliedRubric, improvements: suppliedImprovements } = payload as {
    draftId: string;
    rubric?: Parameters<typeof validateCvRubric>[1];
    improvements?: string[];
    mode?: "assess" | "improve";
  };
  /**
   * This build's own signal. The queue aborts the run's signal when the build outruns its deadline
   * or the task is taken by another worker; the build aborts this one when it learns the same
   * thing from inside — its lease went, its draft was deleted, its budget hold was released. Every
   * model call is made under it, so a build that has been given up on stops paying for answers
   * nobody will read.
   */
  const stop = new AbortController();
  /** Why this build must stop, when something outside the work itself decided it. */
  let interrupted: CvBuildStop | CvDeletedError | undefined;
  const stopBuild = (reason: CvBuildStop | CvDeletedError, cause: unknown = reason) => {
    interrupted ??= reason;
    // The engine labels each stopped call by what aborted it, so a stop the task's own signal
    // brought (its deadline) is passed on as that, and a deadline is recorded as a deadline.
    stop.abort(cause);
  };
  if (ctx?.signal.aborted) stopBuild(new CvBuildStop("worker_interrupted", CV_LOST_PLACE_MESSAGE), ctx.signal.reason);
  else ctx?.signal.addEventListener("abort",
    () => stopBuild(new CvBuildStop("worker_interrupted", CV_LOST_PLACE_MESSAGE), ctx.signal.reason), { once: true });
  const lost = (loss: CvJournalLoss) => stopBuild(loss === "deleted"
    ? new CvDeletedError()
    : new CvBuildStop("worker_interrupted", loss === "hold" ? CV_HOLD_LOST_MESSAGE : CV_LOST_PLACE_MESSAGE));

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
    const [draft] = await deps.db
      .select()
      .from(schema.cvDrafts)
      .where(eq(schema.cvDrafts.id, draftId));
    if (!draft || draft.status === "ready" || draft.status === "awaiting_evidence" || draft.archivedAt) return { skipped: true };

    // A queued row always carries both; a hand-made task in a test may not, and an attempt that
    // is not a number would reach the ledger as a broken row.
    const attempt = Number.isFinite(task.attempts) ? Math.max(1, task.attempts) : 1;
    const maxAttempts = Number.isFinite(task.maxAttempts) ? task.maxAttempts : attempt;
    /** The one hold this build is admitted against, kept alive while the build advances. */
    let hold: AiHold | undefined;
    /**
     * Keep this build's capacity held. A renewal that matches no row means the hold has gone — an
     * expiry, or a release meant for another build — so the budget no longer knows this build is
     * running, and continuing would spend money nothing has admitted.
     */
    const renewHold = async (): Promise<boolean> => {
      if (!hold) return true;
      if (await hold.renew()) return true;
      stopBuild(new CvBuildStop("worker_interrupted", CV_HOLD_LOST_MESSAGE));
      return false;
    };
    // Every motion of this attempt, written as it happens, behind this attempt's fence. A step
    // closing is also the moment the build's reservation is renewed: it is the one event that is
    // always genuine progress.
    const journal = new CvJournal({
      db: deps.db, draftId, userId: draft.userId, taskId: task.id ?? null, attempt, now: deps.now,
      assertOwnership: locked.assertOwnership,
      renewHold,
      onLost: lost,
    });
    // What this build has already paid for. A retry reads it and skips those calls; publication
    // clears it, because a published CV has nothing left to resume.
    let checkpoint: CvBuildCheckpoint = draft.buildCheckpoint ?? {};
    // What the revision's first task asked for, when this task is a retry that was not told: the
    // mode, the improvements and the parent's rubric are kept on the checkpoint for exactly this.
    const mode = requestedMode ?? checkpoint.mode;
    const sourceRubric = suppliedRubric ?? checkpoint.sourceRubric;
    const sourceImprovements = suppliedImprovements ?? checkpoint.improvements;
    let generationError: string | undefined;
    // The last failure each call site reported, and the last record it wrote. A cancelled sibling
    // records no failure of its own, so the batch that actually ended the audit is the one read.
    const callFailures = new Map<string, AiFailure>();
    const callUsage = new Map<string, AiUsageRecord>();
    let writeAttempt = 0;
    try {
      // A build starting afresh clears the last attempt's failure; a queue retry keeps it, because
      // it is why this attempt is happening and the page says so while it runs. Either way it is
      // replaced by whatever this attempt does, and cleared on publication.
      await save({ status: "generating", error: null, finalisedAt: null, ...(attempt === 1 ? { failure: null } : {}) });
      if (!deps.env.anthropicApiKey)
        throw new CvBuildStop("model_access", "Add ANTHROPIC_API_KEY to the worker to generate a CV.");
      const [parent] = draft.parentId
        ? await deps.db
            .select()
            .from(schema.cvDrafts)
            .where(eq(schema.cvDrafts.id, draft.parentId))
        : [];
      const reused = reusedCvRubric(draft, parent, sourceRubric);
      const inputs = await journal.run("load_inputs", {
        libraryVersion: draft.libraryVersion,
        descriptionCharacters: draft.jobDescription.length,
        mode: mode ?? "build",
      }, async step => {
        try {
          const library = groupCvLibrary(CvLibrarySchema.parse(draft.librarySnapshot));
          const counted = (kind: string) => library.entries.filter(entry => entry.kind === kind).length;
          // Saved wording is reused when this build already wrote it (the checkpoint says so) or
          // when the task asked for an assessment of what is stored. Old drafts and manual edits
          // meet the same measured layout gate as fresh writing before the writer is skipped.
          const saved = (mode === "assess" || checkpoint.contentAt) && draft.content
            ? CvContentSchema.parse(draft.content) : undefined;
          const savedPages = saved
            ? await renderCvPdfWithReport(saved)
                .then(report => report.pageCount)
                .catch(error => {
                  if (error instanceof CvLayoutError) return Number.POSITIVE_INFINITY;
                  throw error;
                })
            : undefined;
          // Each saved revision carries its own page limit in its theme.
          const reusedContent = !!saved && savedPages! <= cvMaxPages(saved.theme);
          step.add({
            roles: counted("experience"), qualifications: counted("education"), skillBlocks: counted("skill"),
            reusedRubric: !!reused, reusedContent,
          });
          return { library, saved, reusedContent };
        } catch (error) {
          if (error instanceof CvBuildStop) throw error;
          // Nothing the model produced has been read yet, so whatever is unusable here is the
          // snapshot this build was given: the person fixes it in their Library.
          throw new CvBuildStop("library_invalid", (error as Error).message);
        }
      });
      const { library } = inputs;
      // A build stopped during its optional improvement had already written, assessed and saved
      // its baseline, and the fence says the improvement is not tried twice. Its saved assessment
      // still describes the saved wording, so it is published as it stands: re-running the audit
      // bought the dearest stage of the build a second time for the same answer.
      const baseline = inputs.reusedContent && checkpoint.improvementAttempted &&
        cvAssessmentCurrent(draft.assessment, inputs.saved!, draft.jobDescription, library)
        ? draft.assessment! : undefined;
      // One hold for the whole build, at what it is expected to cost, against the budget of the
      // account that asked for it. A build that account can afford is admitted and never fails
      // part-way over budget accounting; one it cannot afford is refused here, before it spends
      // anything. Holding each call at its ceiling instead refused builds the month could plainly
      // afford, and did so after the rubric and CV had already been paid for.
      //
      // An attempt whose wording is already written and still fits will only re-run the audit, so
      // it is admitted at the audit's share of the estimate rather than the whole build's: holding
      // three times what it can spend refused resumptions the month could plainly afford. Such an
      // attempt may still pay for a rubric it has not inherited, which is cents against a hold
      // measured in dollars, and the hold covers the calls where the money actually is.
      // Publishing a saved baseline calls no model at all, so it holds nothing.
      const expected = baseline ? 0 : estimateCvBuildUsd(draft.model, {
        libraryBytes: Buffer.byteLength(JSON.stringify(library)),
        descriptionBytes: Buffer.byteLength(draft.jobDescription),
      }, inputs.reusedContent
        ? checkpoint.tailoringEnabled && !checkpoint.improvementAttempted && mode !== "assess" ? "tailored_assessment" : "assessment"
        : checkpoint.tailoringEnabled ? (checkpoint.quizCompleted ? "tailored_completion" : "tailored") : "all");
      const account = await deps.userSettings(draft.userId);
      const since = aiBudgetWindowStart(deps.now(), account.aiBudgetResetAt);
      await journal.run("admit_budget", {
        expectedUsd: usd(expected), limitUsd: account.aiBudgetUsd, resumed: inputs.reusedContent,
      }, async step => {
        const admitted = await tryReserveAi(deps.db, "CV", expected, {
          account: { userId: draft.userId, budgetUsd: account.aiBudgetUsd, since },
          daily: deps.env.dailyAiBudgetUsd ?? 1000000,
          discovery: deps.env.discoveryAiBudgetUsd ?? 1000000,
          workerId: deps.env.workerId,
          // Which build this hold is for, so giving up on one build never releases another's.
          refId: draft.id,
        }, deps.now(), 30);
        if ("refused" in admitted) {
          step.add({ limitUsd: admitted.refused.limitUsd, heldUsd: usd(admitted.refused.held),
            leftUsd: usd(Math.max(0, admitted.refused.limitUsd - admitted.refused.spent - admitted.refused.held)) });
          throw new CvBuildStop("budget_exhausted", aiBudgetRefusalMessage("This build", expected, admitted.refused));
        }
        hold = admitted;
        // The figures the hold itself was measured against, inside the lock that took it: a
        // second reading taken outside it could disagree with the decision it is explaining.
        step.add({ limitUsd: admitted.limitUsd, heldUsd: usd(admitted.held + expected),
          leftUsd: usd(Math.max(0, admitted.limitUsd - admitted.spent - admitted.held - expected)) });
      });
      let currentStage: BuildStage | undefined;
      const stage = async (buildStage: BuildStage) => {
        currentStage = buildStage;
        await save({ buildStage });
        await renewHold();
      };
      /**
       * The milestone a motion belongs to, from the catalogue, and never backwards within one
       * attempt: a rewrite belongs to fitting, and the reading of its plan belongs to writing, so
       * taking every motion's stage literally would walk the strip back a milestone mid-attempt.
       */
      const stageFor = async (motion: FitMotion) => {
        const next: BuildStage = CV_BUILD_MOTIONS[motion].stage;
        if (currentStage === next) return;
        if (currentStage && CV_BUILD_STAGES.indexOf(next) < CV_BUILD_STAGES.indexOf(currentStage)) return;
        await stage(next);
      };
      const ai = createAiEngine({
        apiKey: deps.env.anthropicApiKey,
        client: deps.aiClient,
        getModel: () => draft.model,
        // Every call this build makes is made under its signal, so a deadline, a lost lease or a
        // released hold stops the calls as well as the bookkeeping.
        signal: stop.signal,
        onUsage: async ({ failure, ...usage }) => {
          // The failure that ended a build is the one to report: not a batch cancelled because of
          // it, and not a sibling that happened to finish cleanly afterwards.
          if (usage.error && usage.error !== CANCELLED_ERROR && !usage.error.startsWith(INTERRUPTED_ERROR_PREFIX) && !usage.error.startsWith(DEADLINE_ERROR_PREFIX)) generationError = usage.error;
          if (usage.stage) {
            callUsage.set(usage.stage, { ...usage, ...(failure ? { failure } : {}) });
            if (failure) callFailures.set(usage.stage, failure);
          }
          // `failure` is the same event named; `ai_calls` keeps the text it always kept. With the
          // build's hold, the record and the hold's reduction land in one transaction, and a record
          // that cannot be written keeps the hold rather than letting the spend go unaccounted.
          await recordAiUsage(deps.db, draft.userId, usage, { hold });
        },
      });
      /**
       * A call that produced nothing usable, named by what the engine recorded for it rather than
       * by whichever error happened to be most recent. `note` carries the figures the sentence
       * needs, such as which of the three writing attempts this was.
       */
      const requireResult = <T>(value: T | null, stageName: string, doing: CvCallDoing, note?: string): T => {
        if (value) return value;
        // A call that returned nothing because this build was told to stop is that interruption,
        // not a model failure: it never got an answer to be disappointed by.
        if (interrupted) throw interrupted;
        const failure = callFailures.get(stageName) ?? (stageName === "review" ? callFailures.get("review_retry") : undefined);
        const kind: CvFailureKind = failure?.kind ?? "output_invalid";
        throw new CvBuildStop(kind, callFailureMessage(kind, doing, failure?.status, note), {
          ...(generationError ? { cause: generationError.slice(0, 500) } : {}),
        });
      };
      await stage("analysing");
      const rubric = reused
        ? await journal.run("rubric", { reused: reused.reused },
            async () => validateCvRubric(draft.jobDescription, reused.rubric), { status: "skipped" })
        : await journal.run("rubric", {}, async step => {
            const result = requireResult(
              await ai.analyseCvJob(draft.jobDescription, {
                refType: "cv-rubric", refId: draft.id, stage: "rubric", userId: draft.userId,
              }), "rubric", RUBRIC_CALL);
            let validated;
            try {
              validated = validateCvRubric(draft.jobDescription, result);
            } catch (error) {
              // The model quoted something the description does not contain, or weighted a
              // requirement it may not. A fresh answer might not, so this is worth asking again —
              // unlike a rubric inherited from a checkpoint or a parent, which never changes.
              throw new CvBuildStop("output_invalid", (error as Error).message);
            }
            const importance = (value: string) => validated.requirements.filter(item => item.importance === value).length;
            step.add({
              requirements: validated.requirements.length, essential: importance("essential"),
              desirable: importance("desirable"), responsibilities: importance("responsibility"),
              ...callCost(callUsage.get("rubric")),
            });
            return validated;
          });
      // The rubric is the cheapest thing a retry can skip and the one that must not change between
      // attempts, so it is written down the moment it is known to be valid.
      checkpoint = { ...checkpoint, rubric, rubricAt: deps.now().toISOString(), attempt };
      await save({ buildCheckpoint: checkpoint });

      let tailoringPlan = checkpoint.tailoringPlan;
      if (checkpoint.tailoringEnabled && !inputs.reusedContent) {
        tailoringPlan = await journal.run("plan_evidence", { reused: !!tailoringPlan }, async step => {
          const sources = cvTailoringEvidence(library);
          const result = tailoringPlan ?? requireResult(await ai.planCvTailoring({ library, rubric }, {
            refType: "cv-plan", refId: draft.id, stage: "planning", userId: draft.userId,
          }), "planning", { gerund: "matching the role to your evidence", step: "evidence planning" });
          let validated;
          try {
            validated = validateCvTailoringPlan(result, rubric, sources, library);
          } catch (error) {
            throw new CvBuildStop("output_invalid", (error as Error).message);
          }
          step.add({ requirements: validated.requirements.length,
            supported: validated.requirements.filter(item => item.status === "demonstrated" || item.status === "partial").length,
            questions: validated.gapQuestions.length, ...callCost(callUsage.get("planning")) });
          return validated;
        });
        checkpoint = { ...checkpoint, tailoringPlan };
        await save({ buildCheckpoint: checkpoint });
        if (!checkpoint.quizCompleted) {
          const gapQuiz = buildCvGapQuiz(tailoringPlan.gapQuestions, draft.librarySnapshot, draft.libraryVersion, rubric);
          await journal.record("gap_quiz", { questions: gapQuiz?.questions.length ?? 0, skipped: !gapQuiz });
          if (gapQuiz) {
            await save({ status: "awaiting_evidence", gapQuiz, buildStage: null, failure: null, error: null });
            return { draftId, awaitingEvidence: true };
          }
          checkpoint = { ...checkpoint, quizCompleted: true };
          await save({ buildCheckpoint: checkpoint });
        }
      }
      const semantic = tailoringPlan ? { plan: tailoringPlan, rubric } : undefined;

      let content = inputs.reusedContent ? inputs.saved : undefined;
      if (!content) {
        let writeStep: CvOpenStep<"write" | "rewrite"> | null = null;
        try {
          // Saved wording that no longer fits is refitted; a rebuild starts from the Library.
          const initial = inputs.saved ? CvPlanSchema.parse(inputs.saved) : undefined;
          const writingLibrary = inputs.saved
            ? { ...library, theme: inputs.saved.theme ?? library.theme }
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
                    tailoringPlan,
                    ...input,
                  },
                  { refType: "cv-author", refId: draft.id, stage: "author", userId: draft.userId },
                ),
                "author", AUTHOR_CALL, `(attempt ${writeAttempt} of 3)`,
              ),
            initial,
            async (event: CvFitEvent) => {
              // The first attempt writes; the ones after it rewrite to a smaller budget, which is
              // a motion of its own in the catalogue and reads as one in the narrative.
              await stageFor(event.motion === "write" ? writingMotion(event.attempt) : event.motion);
              switch (event.motion) {
                case "write":
                  if (event.phase === "start") {
                    writeAttempt = event.attempt;
                    writeStep = await journal.open(writingMotion(event.attempt), {
                      attempt: event.attempt, budgetCharacters: event.budgetCharacters,
                      budgetScale: event.budgetScale, maxPages: event.maxPages,
                    });
                  } else {
                    await journal.close(writeStep, "done", {
                      roles: event.roles, bullets: event.bullets, characters: event.characters,
                      ...callCost(callUsage.get("author")),
                    });
                    writeStep = null;
                  }
                  return;
                case "check_plan":
                  // A wrong skill format is corrected by the next attempt, so the reading itself
                  // is done; only evidence the writer dropped altogether ends the build.
                  await journal.record("check_plan",
                    { omitted: event.omitted, skillFormatCorrections: event.skillFormatCorrections },
                    event.omitted.length ? "failed" : "done");
                  return;
                case "measure":
                  await journal.record("measure", { pages: event.pages, maxPages: event.maxPages });
                  return;
                case "shorten":
                  await journal.record("shorten",
                    { removed: event.removed, pages: event.pages, changes: event.changes });
                  return;
              }
            },
            semantic,
          );
        } catch (error) {
          if (error instanceof CvBuildStop) throw error;
          if (!(error instanceof CvFitFailure) && writeAttempt === 0)
            // Nothing has been written yet, so this is the evidence the build was given.
            throw new CvBuildStop("library_invalid", (error as Error).message);
          throw error;
        }
        // Retain a recoverable draft if the later assessment call fails, and record that this
        // build has paid for the writing: a retry assesses what is saved instead of rewriting it.
        checkpoint = { ...checkpoint, contentAt: deps.now().toISOString() };
        await save({ content, buildCheckpoint: checkpoint });
      }
      const assessContent = async (candidate: NonNullable<typeof content>) => {
      await stage("assessing");
      const { pageCount, maxPages } = await renderCvPdfWithReport(candidate);
      // A build that skipped the writer never measured anything, so its one measurement is here.
      if (inputs.reusedContent) await journal.record("measure", { pages: pageCount, maxPages });
      assertCvPageLimit(pageCount, maxPages);
      const batchSteps = new Map<number, CvOpenStep<"assess_batch">>();
      const retrySteps = new Map<number, CvOpenStep<"assess_retry">>();
      const requirementsPerBatch = (total: number) => Math.max(1, Math.ceil(rubric.requirements.length / total));
      let review: CvReviewPlan;
      try {
        review = requireResult(
          await ai.assessCv(
            {
              rubric,
              cv: cvTextItems(candidate),
              claims: cvClaimItems(candidate),
              evidence: cvEvidenceItems(library),
            },
            // The engine re-runs a batch whose attribution it had to correct, and names that
            // second charge `review_retry`, so a build that paid twice for one batch says so.
            { refType: "cv-review", refId: draft.id, stage: "review", userId: draft.userId },
            {
              onBatch: async (event) => {
                const first = event.index * requirementsPerBatch(event.total) + 1;
                const position = `(batch ${event.index + 1} of ${event.total})`;
                const title = event.requirements
                  ? `Checking requirements ${first}–${first + event.requirements - 1} and ${event.claims} claims ${position}`
                  : `Checking ${event.claims} claims ${position}`;
                const figures = { batch: event.index + 1, batches: event.total, requirements: event.requirements, claims: event.claims };
                if (event.phase === "start") {
                  batchSteps.set(event.index, await journal.open("assess_batch", figures, title));
                  return;
                }
                if (event.phase === "retry") {
                  // The batch's own call is finished and paid for; the correction is a second charge.
                  await journal.close(batchSteps.get(event.index), "done", callCost(event.usage));
                  batchSteps.delete(event.index);
                  retrySteps.set(event.index, await journal.open("assess_retry",
                    { batch: event.index + 1, corrections: event.corrections ?? 0 }));
                  return;
                }
                const status = event.phase === "done" ? "done" : "failed";
                const retry = retrySteps.get(event.index);
                if (retry) {
                  // The re-run is a call like any other: it is charged what it cost, not zero,
                  // which is what the Operations median for this motion was being told.
                  await journal.close(retry, status, callCost(event.usage));
                  retrySteps.delete(event.index);
                  return;
                }
                await journal.close(batchSteps.get(event.index), status, callCost(event.usage));
                batchSteps.delete(event.index);
              },
            },
          ),
          "review", REVIEW_CALL,
        );
      } catch (error) {
        if (error instanceof CvBuildStop) throw error;
        // The engine throws here only when a batch came back missing requirements or claims it
        // was asked for; the written CV is saved, so another assessment is all that is needed.
        throw new CvBuildStop("assessment_incomplete", (error as Error).message);
      }
      const checked = await journal.run("assemble", { pageCount }, async step => {
        let value: CvAssessment;
        try {
          value = createCvAssessment({
            content: candidate,
            description: draft.jobDescription,
            library,
            rubric,
            review,
            model: draft.model,
            pageCount,
            now: deps.now(),
          });
        } catch (error) {
          // Every quote is checked against its source here; an assessment that cited something
          // that is not there is not the CV's fault and is worth asking for again.
          throw new CvBuildStop("assessment_incomplete", (error as Error).message);
        }
        step.add(assessmentTally(value.review));
        return value;
      });
      return checked;
      };
      let assessment = baseline ?? await assessContent(content!);
      const opportunityIds = new Set(diagnoseCvQuality(assessment, content!).evidencedOpportunityGap.requirementIds);
      const opportunities = assessment.review.matches.filter(match => opportunityIds.has(match.requirementId));
      if (semantic && mode !== "assess" && !checkpoint.improvementAttempted && opportunities.length > 0) {
        // Persist the baseline and the one-shot fence before any optional work is paid for. A
        // crash can resume the verified baseline, without buying the same improvement again.
        checkpoint = { ...checkpoint, improvementAttempted: true };
        await save({ content, assessment, buildCheckpoint: checkpoint });
        const step = await journal.open("improve_content", { opportunities: opportunities.length });
        try {
          const budget = createCvWritingBudget(library, cvRelevanceTerms(rubric.requirements), 1, semantic);
          const plan = requireResult(await ai.buildCv({ library, rubric, tailoringPlan,
            description: draft.jobDescription, jobTitle: draft.jobTitle, company: draft.companyName,
            improvements: opportunities.map(item => item.improvement).filter(Boolean),
            writingBudget: budget, maxPages: cvMaxPages(library.theme),
          }, { refType: "cv-author", refId: draft.id, stage: "improvement", userId: draft.userId }), "improvement", AUTHOR_CALL);
          const omitted = library.entries.filter(entry =>
            (entry.kind === "experience" || entry.kind === "education") &&
            !plan.sections.some(section => section.entryId === entry.id));
          if (omitted.length)
            throw new CvBuildStop("output_invalid", "The optional revision omitted employment or education; the original CV was retained.");
          // The optional pass strengthens role evidence. Preserve the already checked qualification
          // wording, so retaining an education block cannot conceal the loss of one qualification.
          const baselineQualifications = new Map(CvPlanSchema.parse(content).sections
            .filter(section => library.entries.some(entry => entry.id === section.entryId && entry.kind === "education"))
            .map(section => [section.entryId, section]));
          plan.sections = plan.sections.map(section => baselineQualifications.get(section.entryId) ?? section);
          // One author call only. Deterministic fitting may remove whole lower-value bullets; an
          // unfittable or unsupported candidate is discarded rather than starting another loop.
          const fitted = await selectCvToFit(library, plan, cvRelevanceTerms(rubric.requirements), budget, semantic);
          assertCvPageLimit(fitted.pageCount, cvMaxPages(library.theme));
          await journal.close(step, "done", callCost(callUsage.get("improvement")));
          const candidateAssessment = await assessContent(fitted.content);
          const comparison = compareCvQuality(assessment, content!, candidateAssessment, fitted.content);
          await journal.record("compare_content", { accepted: comparison.accept, reasons: comparison.reasons });
          if (comparison.accept) {
            content = fitted.content;
            assessment = candidateAssessment;
            await save({ content, assessment, buildCheckpoint: checkpoint });
          }
        } catch (error) {
          if (interrupted || error instanceof CvDeletedError) throw interrupted ?? error;
          // Optional polish must not turn an already verified draft into a failed build.
          await journal.failOpen(`Kept the original CV: ${(error as Error).message}`);
          await journal.record("compare_content", { accepted: false, reasons: ["The optional revision could not be verified; the checked original was retained."] });
        }
      } else if (semantic && !checkpoint.improvementAttempted) {
        await journal.record("improve_content", { opportunities: 0, skipped: true, reason: "No important evidence available in the Library was omitted." }, "skipped");
      }
      const revision = Math.max(1, draft.revision);
      await journal.run("publish", { revision }, async step => {
        step.add({ archivedPrevious: await archivesPrevious(deps.db, draft) });
        await save({
          status: "ready",
          buildStage: null,
          content,
          assessment,
          revision,
          // Nothing is left to resume and nothing is left to explain.
          buildCheckpoint: null,
          failure: null,
        });
      });
      return { draftId, ready: true };
    } catch (error) {
      // Something outside the work told this build to stop, and whatever the work then threw is a
      // consequence of that rather than the reason: the interruption is what the person is told.
      const cause = interrupted ?? error;
      if (cause instanceof CvDeletedError) return { draftId, skipped: true, reason: "deleted" };
      const failure = cvBuildFailureFor(cause, { attempt, maxAttempts });
      const message = failure.message;
      // The system resolves what it can: the draft stays alive, the checkpoint stays with it, and
      // the queue brings the build back to finish what it has already paid for.
      if (failure.resolvedBy === "system" && failure.retryable && attempt < maxAttempts) {
        const retrying = { ...failure, retryAt: new Date(deps.now().getTime() + backoffMs(attempt)).toISOString() };
        await journal.failOpen(message, retrying);
        log.warn("CV build will be retried", { draftId, kind: failure.kind, attempt, maxAttempts });
        try {
          await save({ failure: retrying });
        } catch (saveError) {
          if (saveError instanceof CvDeletedError) return { draftId, skipped: true, reason: "deleted" };
          throw saveError;
        }
        throw new CvRetryableBuildError(message);
      }
      await journal.failOpen(message, failure);
      log.warn("CV generation failed", { draftId, kind: failure.kind, resolvedBy: failure.resolvedBy, attempt });
      try {
        await save({ status: "failed", error: message.slice(0, 1000), buildStage: null, failure });
      } catch (saveError) {
        if (saveError instanceof CvDeletedError) return { draftId, skipped: true, reason: "deleted" };
        throw saveError;
      }
      return { draftId, failed: true, error: message };
    } finally {
      await hold?.release();
    }
  }, {
    busyMessage: CV_BUSY_MESSAGE,
    // The lease went to another worker, so every write from here would be stale: stop the model
    // calls rather than finish a build whose result nothing will accept.
    onLost: () => stopBuild(new CvBuildStop("worker_interrupted", CV_LOST_PLACE_MESSAGE)),
  });
}
