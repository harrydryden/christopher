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
  type CvRubric,
} from "@ava/core/cv-assessment";
import { cvTailoringEvidence, validateCvPlanProvenance, validateCvTailoringPlan, type CvTailoringPlan } from "@ava/core/cv-tailoring";
import { buildCvGapQuiz } from "@ava/core/cv-gap-quiz";
import { compareCvQuality, diagnoseCvQuality } from "@ava/core/cv-quality";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { completeCv, cvRoleKey, type AiCallRecord, releaseAiHolds, saveCvTailoringPlan, saveImprovedCvRevision, schema, skipOpenCvBuildSteps, type Task, type Db } from "@ava/db";
import { ASSESSMENT_COVERAGE_ERROR, createAiEngine, CANCELLED_ERROR, cvClaimMemoFrom, cvClaimMemoKeys, DEADLINE_ERROR_PREFIX, INTERRUPTED_ERROR_PREFIX, type AiFailure, type CvAssessBatchResult, type CvClaimMemo } from "@ava/ai";
import {
  CvContentSchema,
  CvPlanSchema,
  CvLibrarySchema,
  CV_BUILD_MOTIONS,
  CV_BUILD_STAGES,
  aiBudgetRefusalMessage,
  aiBudgetWindowStart,
  assessmentTally,
  cvMaxPages,
  cvRelevanceTerms,
  createCvWritingBudget,
  groupCvLibrary,
  readCvBuildCheckpoint,
  reusedCvRubric,
  usd,
  type CvAuditPass,
  type CvBuildCheckpoint,
  type CvBuildMotion,
  type CvBuildStageName,
  type CvContent,
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
import { recordAiUsage, tryReserveAi, type AiBudgetLimits, type AiBudgetRefusal, type AiHold } from "../budget";
import { backoffMs, type TaskRunContext } from "../queue";
import { CvJournal, type CvJournalLoss, type CvOpenStep } from "./cv-journal";
import {
  CV_STAGE_LABELS,
  CvStageRunner,
  cvAuditBatches,
  estimateCvStage,
  promptSetVersion,
  type CvStage,
  type CvStageHold,
} from "./cv-stages";
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** A sentence from the comparison or a thrown error, as the tail of "Kept the original: …". */
function keptBecause(sentence: string): string {
  const trimmed = sentence.trim().replace(/\.$/, "");
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

/**
 * Where a build's budget holds and cost records go. A queued build uses the database's budget
 * (`tryReserveAi`, `recordAiUsage`); a replay (`cv-replay.ts`) holds nothing and keeps its records
 * in memory, so rebuilding a draft to grade it never reserves or charges an account's budget.
 */
export interface CvBuildSink {
  reserve(expectedUsd: number, limits: AiBudgetLimits): Promise<AiHold | { refused: AiBudgetRefusal }>;
  record(usage: AiCallRecord, hold: AiHold | undefined): Promise<void>;
}

/** A run of the handler: the queue's context, and optionally a sink other than the database's. */
export type CvRunContext = TaskRunContext & {
  sink?: CvBuildSink;
  /** Per-stage allowances in place of the calibration constants; a test shortens them. */
  stageAllowanceMs?: Partial<Record<CvBuildStageName, number>>;
};

/** What the saved writing recorded: which attempt produced it and the budget scale it fitted at. */
type WriteCheckpoint = { writeAttempt: number; scale: number };

/** All generation and review modes use the same immutable input snapshot and lease. */
export async function handleGenerateCv(task: Task, deps: WorkerDeps, ctx?: CvRunContext) {
  const payload = task.payload;
  if (!payload || typeof payload !== "object" || typeof payload.draftId !== "string" || !UUID.test(payload.draftId) ||
      (payload.userId !== undefined && (typeof payload.userId !== "string" || !UUID.test(payload.userId))) ||
      (payload.mode !== undefined && payload.mode !== "assess" && payload.mode !== "improve") ||
      (payload.improvements !== undefined && (!Array.isArray(payload.improvements) || !payload.improvements.every(value => typeof value === "string")))) {
    throw new Error("Invalid CV generation task.");
  }
  const { draftId, userId: payloadUserId, mode: requestedMode, rubric: suppliedRubric, improvements: suppliedImprovements } = payload as {
    draftId: string;
    userId?: string;
    rubric?: CvRubric;
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
    if (draft?.status === "ready") {
      // A published CV is not built again. If this task is the one whose optional improvement was
      // cut off with its process, the motions it left open are closed here, as skipped: nothing
      // else will, and the page would otherwise go on showing them running.
      const closed = await skipOpenCvBuildSteps(deps.db, draft.id).catch(() => 0);
      if (closed) log.info("closed the steps an interrupted improvement left open", { draftId, closed });
      return { skipped: true };
    }
    if (!draft || draft.status === "awaiting_evidence" || draft.archivedAt) return { skipped: true };
    // A payload naming another account is not this draft's task: nothing is read or written for it.
    if (payloadUserId && payloadUserId !== draft.userId) {
      log.warn("CV task names a different account from its draft; ignored", { draftId, taskId: task.id });
      return { skipped: true, reason: "account" };
    }

    const sink: CvBuildSink = ctx?.sink ?? {
      reserve: (expected, limits) => tryReserveAi(deps.db, "CV", expected, limits, deps.now(), 30),
      record: (usage, hold) => recordAiUsage(deps.db, draft.userId, usage, { hold }),
    };
    // A queued row always carries both; a hand-made task in a test may not, and an attempt that
    // is not a number would reach the ledger as a broken row.
    const attempt = Number.isFinite(task.attempts) ? Math.max(1, task.attempts) : 1;
    const maxAttempts = Number.isFinite(task.maxAttempts) ? task.maxAttempts : attempt;
    /**
     * The hold of the stage running now, if one is. Each stage admits its own expected cost just
     * before it runs and gives it back when it closes, so between stages — and through the quiz
     * pause — this build holds nothing.
     */
    let hold: AiHold | undefined;
    /** What this attempt's stages were admitted at, in all, for the publication's figures. */
    let reservedUsd = 0;
    /**
     * Keep the running stage's capacity held. A renewal that matches no row means the hold has
     * gone — an expiry, or a release meant for another build — so the budget no longer knows this
     * stage is running, and continuing would spend money nothing has admitted.
     */
    const renewHold = async (): Promise<boolean> => {
      if (!hold) return true;
      if (await hold.renew()) return true;
      stopBuild(new CvBuildStop("worker_interrupted", CV_HOLD_LOST_MESSAGE));
      return false;
    };
    // Every motion of this attempt, written as it happens, behind this attempt's fence. A step
    // closing is also the moment the running stage's reservation is renewed: it is the one event
    // that is always genuine progress.
    const journal = new CvJournal({
      db: deps.db, draftId, userId: draft.userId, taskId: task.id ?? null, attempt, now: deps.now,
      assertOwnership: locked.assertOwnership,
      renewHold,
      onLost: lost,
    });
    // What this build has already paid for, stage by stage, pinned to the prompts that made it: a
    // build resumed after a release with different prompts reuses nothing they produced.
    const prompts = promptSetVersion();
    const read = readCvBuildCheckpoint(draft.buildCheckpoint, prompts);
    let checkpoint: CvBuildCheckpoint = read.checkpoint;
    if (read.discarded) log.info("CV checkpoint made by other prompts; starting its paid stages again", { draftId, prompts });
    // A direct edit's own task says `assess`; a retry of one that knows only the draft used to be
    // rewritten from the Library, because the interface does not carry the mode onto the retried
    // draft. A revision that arrives with the person's wording, no mode and no writing of its own
    // is that edit, and it is assessed as typed.
    const directEdit = !requestedMode && !checkpoint.mode && !!draft.content && !!draft.parentId &&
      !checkpoint.contentAt && !checkpoint.stages?.write;
    const mode = requestedMode ?? checkpoint.mode ?? (directEdit ? "assess" : undefined);
    const sourceRubric = suppliedRubric ?? checkpoint.sourceRubric;
    const sourceImprovements = suppliedImprovements ?? checkpoint.improvements;
    // What this task asked for, written where a retry that knows only the draft will find it.
    checkpoint = {
      ...checkpoint,
      ...(mode ? { mode } : {}),
      ...(sourceRubric ? { sourceRubric } : {}),
      ...(sourceImprovements ? { improvements: sourceImprovements } : {}),
    };
    let generationError: string | undefined;
    // The last failure each call site reported, and the steps its calls are charged to. A
    // cancelled sibling records no failure of its own, so the batch that actually ended the audit
    // is the one read.
    const callFailures = new Map<string, AiFailure>();
    const callSteps = new Map<string, { addCost: CvOpenStep["addCost"] }>();
    let writeAttempt = 0;
    let writeScale = 1;
    /** Set once the CV is ready: what follows is optional, and nothing it does can fail the build. */
    let published = false;
    try {
      // A build starting afresh clears the last attempt's failure; a queue retry keeps it, because
      // it is why this attempt is happening and the page says so while it runs. Either way it is
      // replaced by whatever this attempt does, and cleared on publication.
      await save({ status: "generating", error: null, finalisedAt: null, buildCheckpoint: checkpoint, ...(attempt === 1 ? { failure: null } : {}) });
      if (!deps.env.anthropicApiKey)
        throw new CvBuildStop("model_access", "Add ANTHROPIC_API_KEY to the worker to generate a CV.");
      const [parent] = draft.parentId
        ? await deps.db
            .select()
            .from(schema.cvDrafts)
            .where(eq(schema.cvDrafts.id, draft.parentId))
        : [];
      // This build's own rubric first, then the task's, then the parent's for the same description:
      // a direct edit whose checkpoint the interface stripped still takes its parent's rubric
      // before it pays for a new one.
      const reused = reusedCvRubric({ ...draft, buildCheckpoint: checkpoint }, parent, sourceRubric);
      const inputs = await journal.run("load_inputs", {
        libraryVersion: draft.libraryVersion,
        descriptionCharacters: draft.jobDescription.length,
        mode: mode ?? "build",
        maxAttempts,
      }, async step => {
        try {
          const library = groupCvLibrary(CvLibrarySchema.parse(draft.librarySnapshot));
          const counted = (kind: string) => library.entries.filter(entry => entry.kind === kind).length;
          // Saved wording is reused when this build already wrote it (the checkpoint says so) or
          // when the task asked for an assessment of what is stored. Old drafts and manual edits
          // meet the same measured layout gate as fresh writing before the writer is skipped.
          const fromCheckpoint = !!(checkpoint.stages?.write || checkpoint.contentAt);
          const saved = (mode === "assess" || fromCheckpoint) && draft.content
            ? CvContentSchema.parse(draft.content) : undefined;
          let savedPages: number | undefined;
          if (saved) {
            const maxPages = cvMaxPages(saved.theme);
            const measure = await journal.open("measure", { maxPages });
            savedPages = await renderCvPdfWithReport(saved)
              .then(report => report.pageCount)
              .catch(error => {
                if (error instanceof CvLayoutError) return Number.POSITIVE_INFINITY;
                throw error;
              });
            await journal.close(measure, "done", Number.isFinite(savedPages)
              ? { pages: savedPages, renders: 1, outcome: savedPages <= maxPages ? "fits" : "overflow" }
              : { renders: 1, outcome: "layout_error" });
          }
          // Each saved revision carries its own page limit in its theme.
          const reusedContent = !!saved && savedPages! <= cvMaxPages(saved.theme);
          step.add({
            roles: counted("experience"), qualifications: counted("education"), skillBlocks: counted("skill"),
            reusedRubric: !!reused, reusedContent,
          });
          return { library, saved, reusedContent, fromCheckpoint, savedPages };
        } catch (error) {
          if (error instanceof CvBuildStop) throw error;
          // Nothing the model produced has been read yet, so whatever is unusable here is the
          // snapshot this build was given: the person fixes it in their Library.
          throw new CvBuildStop("library_invalid", (error as Error).message);
        }
      });
      const { library } = inputs;
      const sizes = {
        libraryBytes: Buffer.byteLength(JSON.stringify(library)),
        descriptionBytes: Buffer.byteLength(draft.jobDescription),
      };
      // The administrator's per-stage routes: each stage is priced, and called, at its own model.
      // Read once for the attempt; a settings fault prices every stage at its entry's own route.
      const stageRoutes = await Promise.resolve(deps.settings?.()).then(settings => settings?.stageRoutes ?? null).catch(() => null);
      const models = { cvModel: draft.model, routes: stageRoutes };
      // A version 1 build stopped during its optional improvement had already written, assessed
      // and saved its baseline, and its fence says the improvement is not tried twice. Its saved
      // assessment still describes the saved wording, so it is published as it stands.
      const legacyFenced = !!checkpoint.improvementAttempted;
      const baseline = inputs.reusedContent && legacyFenced &&
        cvAssessmentCurrent(draft.assessment, inputs.saved!, draft.jobDescription, library)
        ? draft.assessment! : undefined;
      const account = await deps.userSettings(draft.userId);
      const since = aiBudgetWindowStart(deps.now(), account.aiBudgetResetAt);
      /**
       * Admit one stage against the account's budget, inside the account's lock, immediately
       * before it runs. Any other hold for this draft is dead — a stage whose release was lost, or
       * the hold of an attempt the queue gave up on — and is replaced in the same lock rather than
       * counted beside this one. A stage the month cannot afford fails the build here, before it
       * spends anything, naming the stage and the figures; the calls inside an admitted stage are
       * not held again, so a build never fails part-way through a stage over accounting.
       */
      const admit = async (stageName: CvBuildStageName, expected: number): Promise<CvStageHold> =>
        journal.run("admit_budget", { stage: stageName, expectedUsd: usd(expected) }, async step => {
          const admitted = await sink.reserve(expected, {
            account: { userId: draft.userId, budgetUsd: account.aiBudgetUsd, since },
            daily: deps.env.dailyAiBudgetUsd ?? 1000000,
            discovery: deps.env.discoveryAiBudgetUsd ?? 1000000,
            workerId: deps.env.workerId,
            // Which build this hold is for, so giving up on one build never releases another's.
            refId: draft.id,
            replaceRef: true,
          });
          if ("refused" in admitted) {
            step.add({ limitUsd: admitted.refused.limitUsd, heldUsd: usd(admitted.refused.held),
              leftUsd: usd(Math.max(0, admitted.refused.limitUsd - admitted.refused.spent - admitted.refused.held)) });
            const refusal = new CvBuildStop("budget_exhausted",
              aiBudgetRefusalMessage(`This build's ${CV_STAGE_LABELS[stageName]}`, expected, admitted.refused), { motion: "admit_budget" });
            // After publication a refusal only means the optional work is not done: the step
            // closes as skipped here, because nothing downstream fails it or ever will.
            if (published) await journal.close(step, "skipped", { reason: keptBecause(refusal.message) });
            throw refusal;
          }
          hold = admitted;
          reservedUsd += expected;
          // The figures the hold itself was measured against, inside the lock that took it: a
          // second reading taken outside it could disagree with the decision it is explaining.
          // What the account's other work holds; this stage's own hold is not in it.
          step.add({ limitUsd: admitted.limitUsd, heldUsd: usd(admitted.held),
            leftUsd: usd(Math.max(0, admitted.limitUsd - admitted.spent - admitted.held - expected)) });
          return {
            release: async () => {
              if (hold === admitted) hold = undefined;
              await admitted.release();
            },
          };
        });
      const runner = new CvStageRunner({
        checkpoint: () => checkpoint,
        persist: async next => {
          checkpoint = next;
          if (!published) await save({ buildCheckpoint: next });
        },
        admit,
        signal: stop.signal,
        model: draft.model,
        routes: stageRoutes,
        promptSetVersion: prompts,
        now: deps.now,
        ...(ctx?.stageAllowanceMs ? { allowanceMs: ctx.stageAllowanceMs } : {}),
      });
      let currentStage: BuildStage | undefined;
      const stage = async (buildStage: BuildStage) => {
        // A published CV has no stage: the strip is finished, whatever the optional work does.
        if (published) return;
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
        const next: BuildStage = CV_BUILD_MOTIONS[motion].stage as BuildStage;
        if (currentStage === next) return;
        if (currentStage && CV_BUILD_STAGES.indexOf(next) < CV_BUILD_STAGES.indexOf(currentStage)) return;
        await stage(next);
      };
      const ai = createAiEngine({
        apiKey: deps.env.anthropicApiKey,
        client: deps.aiClient,
        getModel: () => draft.model,
        getStageRoutes: async () => stageRoutes,
        // Every call this build makes is made under its signal, so a deadline, a lost lease or a
        // released hold stops the calls as well as the bookkeeping.
        signal: stop.signal,
        onUsage: async ({ failure, ...usage }) => {
          // The failure that ended a build is the one to report: not a batch cancelled because of
          // it, and not a sibling that happened to finish cleanly afterwards.
          if (usage.error && usage.error !== CANCELLED_ERROR && !usage.error.startsWith(INTERRUPTED_ERROR_PREFIX) && !usage.error.startsWith(DEADLINE_ERROR_PREFIX)) generationError = usage.error;
          if (usage.stage) {
            if (failure) callFailures.set(usage.stage, failure);
            // Every call is charged to the step that made it, whether it succeeded, failed or was
            // cancelled part-way: what it consumed is on the step however the step ends.
            callSteps.get(usage.stage)?.addCost(usage);
          }
          // `failure` is the same event named; `ai_calls` keeps the text it always kept. With the
          // stage's hold, the record and the hold's reduction land in one transaction, and a record
          // that cannot be written keeps the hold rather than letting the spend go unaccounted.
          await sink.record(usage, hold);
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
        const failure = callFailures.get(stageName) ?? callFailures.get(`${stageName}_retry`);
        const kind: CvFailureKind = failure?.kind ?? "output_invalid";
        throw new CvBuildStop(kind, callFailureMessage(kind, doing, failure?.status, note, failure?.stall), {
          ...(generationError ? { cause: generationError.slice(0, 500) } : {}),
        });
      };
      /** A call's reference: the draft, the stage, the stop, and the journal step it is charged to. */
      const ref = (stageName: string, refType: string, signal: AbortSignal, stepId?: string | null) =>
        ({ refType, refId: draft.id, stage: stageName, userId: draft.userId, signal, ...(stepId ? { stepId } : {}) });

      // ---- The rubric ------------------------------------------------------------------------
      await stage("analysing");
      const rubricStage: CvStage<{ description: string }, CvRubric> = {
        name: "rubric", admission: "rubric", motion: "rubric",
        key: input => input,
        estimate: () => estimateCvStage("rubric", sizes, models),
        run: (input, stageCtx) => journal.run("rubric", {}, async step => {
          callSteps.set("rubric", step);
          const result = requireResult(await ai.analyseCvJob(input.description, ref("rubric", "cv-rubric", stageCtx.signal, step.id)), "rubric", RUBRIC_CALL);
          let validated: CvRubric;
          try {
            validated = validateCvRubric(input.description, result);
          } catch (error) {
            // The model quoted something the description does not contain, or weighted a
            // requirement it may not. A fresh answer might not, so this is worth asking again —
            // unlike a rubric inherited from a checkpoint or a parent, which never changes.
            throw new CvBuildStop("output_invalid", (error as Error).message, { motion: "rubric" });
          }
          const importance = (value: string) => validated.requirements.filter(item => item.importance === value).length;
          step.add({
            requirements: validated.requirements.length, essential: importance("essential"),
            desirable: importance("desirable"), responsibilities: importance("responsibility"),
          });
          return validated;
        }),
        validate: (value, input) => validateCvRubric(input.description, value),
        // The rubric is the one thing that must not change between attempts; the interface reads
        // these two to say a retry will not pay for it again.
        mirror: value => ({ rubric: value, rubricAt: deps.now().toISOString(), attempt }),
      };
      const rubric: CvRubric = reused
        ? await journal.run("rubric", { reused: reused.reused },
            async () => validateCvRubric(draft.jobDescription, reused.rubric), { status: "skipped" })
        : (await runner.run(rubricStage, { description: draft.jobDescription })).value;
      if (reused) await runner.save(rubricStage, { description: draft.jobDescription }, rubric);

      // ---- The evidence plan and the optional questions ---------------------------------------
      let tailoringPlan: CvTailoringPlan | undefined = checkpoint.tailoringPlan;
      if (checkpoint.tailoringEnabled && !inputs.reusedContent) {
        const planStage: CvStage<{ rubric: CvRubric; library: typeof library }, CvTailoringPlan> = {
          name: "plan", admission: "plan", motion: "plan_evidence",
          key: input => input,
          estimate: () => estimateCvStage("plan", sizes, models),
          run: (input, stageCtx) => journal.run("plan_evidence", {}, async step => {
            callSteps.set("planning", step);
            const result = requireResult(await ai.planCvTailoring({ library: input.library, rubric: input.rubric },
              ref("planning", "cv-plan", stageCtx.signal, step.id)), "planning", { gerund: "matching the role to your evidence", step: "evidence planning" });
            const validated = validatePlan(result, input);
            step.add({ reused: false, ...planFigures(validated) });
            return validated;
          }),
          validate: (value, input) => validatePlan(value, input),
          mirror: value => ({ tailoringPlan: value }),
        };
        const planInputs = { rubric, library };
        // A version 1 checkpoint carries its plan without a key; it was validated against this
        // rubric and library when it was made, and is checked again here.
        const legacyPlan = !checkpoint.stages?.plan && tailoringPlan ? tailoringPlan : undefined;
        const savedPlan = runner.lookup(planStage, planInputs) ?? (legacyPlan ? validatePlan(legacyPlan, planInputs) : undefined);
        if (savedPlan) {
          tailoringPlan = savedPlan;
          await journal.record("plan_evidence", { reused: true, ...planFigures(savedPlan) }, "skipped");
          if (legacyPlan) await runner.save(planStage, planInputs, savedPlan);
        } else {
          tailoringPlan = (await runner.run(planStage, planInputs)).value;
        }
        if (!checkpoint.quizCompleted) {
          const gapQuiz = buildCvGapQuiz(tailoringPlan.gapQuestions, draft.librarySnapshot, draft.libraryVersion, rubric);
          await journal.record("gap_quiz", { questions: gapQuiz?.questions.length ?? 0, skipped: !gapQuiz });
          if (gapQuiz) {
            // Nothing is held here: the plan's stage gave its hold back when it closed.
            await save({ status: "awaiting_evidence", gapQuiz, buildStage: null, failure: null, error: null });
            return { draftId, awaitingEvidence: true };
          }
          checkpoint = { ...checkpoint, quizCompleted: true };
          await save({ buildCheckpoint: checkpoint });
        }
      }
      const semantic = tailoringPlan ? { plan: tailoringPlan, rubric } : undefined;
      const target = cvRelevanceTerms(rubric.requirements);

      // ---- The writing -------------------------------------------------------------------------
      let content: CvContent | undefined = inputs.reusedContent ? inputs.saved : undefined;
      const savedWrite = checkpoint.stages?.write?.value as WriteCheckpoint | undefined;
      if (content && inputs.fromCheckpoint && mode !== "assess") {
        writeScale = savedWrite?.scale ?? 1;
        await journal.record("write", { reused: "checkpoint", attempt: savedWrite?.writeAttempt ?? 1 }, "skipped");
      }
      if (!content) {
        const writeStage: CvStage<{ draftId: string; libraryVersion: number }, WriteCheckpoint> = {
          name: "write", admission: "write", motion: "write",
          key: input => input,
          estimate: () => estimateCvStage("write", sizes, models),
          run: async () => ({ writeAttempt, scale: writeScale }),
          validate: value => value,
          mirror: () => ({ contentAt: deps.now().toISOString() }),
        };
        let writeStep: CvOpenStep<"write" | "rewrite"> | null = null;
        let measureStep: CvOpenStep<"measure"> | null = null;
        const fitted = await runner.paid("write", "write", writeStage.estimate({ draftId, libraryVersion: draft.libraryVersion }), async stageCtx => {
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
            return await buildFittedCv(
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
                    ref("author", "cv-author", stageCtx.signal, (writeStep as CvOpenStep | null)?.id),
                  ),
                  "author", AUTHOR_CALL, `(attempt ${writeAttempt} of 3)`,
                ),
              initial,
              async (event: CvFitEvent) => {
                // The first attempt writes; the ones after it rewrite to a smaller budget, which is
                // a motion of its own in the catalogue and reads as one in the narrative. The
                // measurement's milestone lights when the measurement opens, as fitting starts.
                if (event.motion === "write") {
                  if (event.phase === "start") await stageFor(writingMotion(event.attempt));
                } else if (event.motion !== "measure" || event.phase === "start") await stageFor(event.motion);
                switch (event.motion) {
                  case "write":
                    if (event.phase === "start") {
                      writeAttempt = event.attempt;
                      writeScale = event.budgetScale;
                      writeStep = await journal.open(writingMotion(event.attempt), {
                        attempt: event.attempt, budgetCharacters: event.budgetCharacters,
                        budgetScale: event.budgetScale, maxPages: event.maxPages,
                        ...(event.attempt > 1 && event.reason ? { reason: event.reason, pages: event.pages } : {}),
                        ...(event.attempt > 1 && event.corrections ? { corrections: event.corrections } : {}),
                      });
                      if (writeStep) callSteps.set("author", writeStep);
                    } else {
                      await journal.close(writeStep, "done", {
                        roles: event.roles, bullets: event.bullets, characters: event.characters,
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
                    if (event.phase === "start") {
                      measureStep = await journal.open("measure", { maxPages: event.maxPages });
                    } else {
                      await journal.close(measureStep, "done", {
                        ...(event.pages !== undefined ? { pages: event.pages } : {}),
                        ...(event.renders !== undefined ? { renders: event.renders } : {}),
                        outcome: event.outcome,
                      });
                      measureStep = null;
                    }
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
        });
        content = fitted;
        // Retain a recoverable draft if the later assessment fails, and record that this build has
        // paid for the writing: a retry assesses what is saved instead of rewriting it. The
        // content and its checkpoint entry are one write, so neither can exist without the other.
        const writeInputs = { draftId, libraryVersion: draft.libraryVersion };
        const writeValue: WriteCheckpoint = { writeAttempt, scale: writeScale };
        checkpoint = {
          ...checkpoint, contentAt: deps.now().toISOString(),
          stages: { ...(checkpoint.stages ?? {}), write: { key: runner.keyFor(writeStage, writeInputs), at: deps.now().toISOString(), value: writeValue } },
        };
        await save({ content, buildCheckpoint: checkpoint });
      }

      // ---- The audit ---------------------------------------------------------------------------
      /**
       * The baseline audit's claim verdicts, filed by memo key (`cvClaimMemoKeys`) beside its batches
       * in the checkpoint. The revision's re-check sends only the claims the revision changed and
       * takes the rest from here. Keyed like every stage by the prompt set and the model, and each
       * verdict's own key names the prompt version, model and effort, so a memo made under other
       * prompts or another route is never used.
       */
      type ClaimMemoInputs = { rubric: CvRubric; evidence: ReturnType<typeof cvEvidenceItems> };
      const claimMemoStage: CvStage<ClaimMemoInputs, CvClaimMemo> = {
        name: "audit.claims", admission: "audit", motion: "assess_batch",
        key: input => input,
        estimate: () => 0,
        run: async () => { throw new Error("The claim memo is written from a finished audit."); },
        validate: value => value,
      };
      /**
       * Assess one candidate: every batch not already held, as stages of one admission, then the
       * score. The baseline's batches are saved as they finish, so a failed batch is the only one a
       * retry pays for; the revision's re-check runs after publication, saves nothing, and asks only
       * about the claims the baseline's audit did not already judge.
       */
      const assessContent = async (candidate: CvContent, pass: CvAuditPass, knownPages?: number): Promise<CvAssessment> => {
        await stage("assessing");
        const pageCount = knownPages ?? (await renderCvPdfWithReport(candidate)).pageCount;
        assertCvPageLimit(pageCount, cvMaxPages(candidate.theme));
        const items = { rubric, cv: cvTextItems(candidate), claims: cvClaimItems(candidate), evidence: cvEvidenceItems(library) };
        const batches = cvAuditBatches(items);
        type AuditInputs = { cv: typeof items.cv; claims: typeof items.claims; evidence: typeof items.evidence; rubric: CvRubric; index: number; total: number };
        const auditStage = (index: number): CvStage<AuditInputs, CvReviewPlan> => ({
          name: `audit[${index}]`, admission: pass === "draft" ? "audit" : "reaudit", motion: "assess_batch",
          key: input => input,
          estimate: () => estimateCvStage(pass === "draft" ? "audit" : "reaudit", { ...sizes, batches: 1 }, models),
          run: async () => { throw new Error("An audit batch runs with its siblings."); },
          validate: value => value,
        });
        const inputsFor = (index: number): AuditInputs =>
          ({ cv: items.cv, claims: items.claims, evidence: items.evidence, rubric, index, total: batches.length });
        const held = new Map<number, CvReviewPlan>();
        if (pass === "draft")
          batches.forEach((_, index) => {
            const saved = runner.lookup(auditStage(index), inputsFor(index));
            if (saved) held.set(index, saved);
          });
        const pending = batches.map((_, index) => index).filter(index => !held.has(index));
        const admission: CvBuildStageName = pass === "draft" ? "audit" : "reaudit";
        const memoInputs: ClaimMemoInputs = { rubric, evidence: items.evidence };
        const claimMemo = pass === "revision" ? runner.lookup(claimMemoStage, memoInputs) : undefined;
        /** The revision's audit as the engine merged it, with the memo's verdicts in place. */
        let merged: CvReviewPlan | null = null;
        let total = batches.length;
        const batchSteps = new Map<number, CvOpenStep<"assess_batch">>();
        const retrySteps = new Map<number, CvOpenStep<"assess_retry">>();
        const ran: CvAssessBatchResult[] = [];
        /** The audit stage's own signal: aborted by its allowance as well as by the build's stop. */
        let stageSignal: AbortSignal | undefined;
        // What the audit will actually send: for the revision's re-check with a memo, only the
        // claims the memo does not hold, beside every requirement — so it is admitted at the price
        // of those batches, not the full audit's.
        let sending = pending.length;
        if (claimMemo) {
          const keys = cvClaimMemoKeys(items, await ai.claimMemoRoute("revision"));
          sending = cvAuditBatches({ rubric, claims: items.claims.filter(claim => !claimMemo[keys.get(claim.id)!]) }).length;
        }
        if (pending.length) {
          const audit = await runner.paid(admission, "assess_batch",
            estimateCvStage(admission, { ...sizes, batches: sending }, models), stageCtx => {
              stageSignal = stageCtx.signal;
              // The audit's calls are charged to the first batch step it opens: the engine reads the
              // reference as each call is made, and every batch's first call follows its step opening.
              const auditRef: ReturnType<typeof ref> & { stepId?: string } = ref("review", "cv-review", stageCtx.signal);
              return ai.assessCvBatches(items,
              // The engine re-runs a batch whose attribution it had to correct, and names that
              // second charge `review_retry` (`review_candidate_retry` for the revision's re-check),
              // so a build that paid twice for one batch says so.
              auditRef,
              {
                pass,
                // Only the batches this build does not already hold: a retry pays for what it lost.
                // The revision's re-check holds none, and sends only the claims the memo lacks.
                ...(pass === "draft" ? { only: pending } : claimMemo ? { claimMemo } : {}),
                onBatch: async event => {
                  const position = `(batch ${event.index + 1} of ${event.total})`;
                  if (event.phase === "start") {
                    // The engine spreads the requirements evenly over its batches, as `cvAuditBatches`
                    // does; a re-check that sends fewer claims has fewer batches than this build's slicing.
                    const first = event.index * Math.ceil(rubric.requirements.length / event.total) + 1;
                    const parts = [
                      event.requirements ? `requirements ${first}–${first + event.requirements - 1}` : "",
                      event.claims ? `${event.claims} ${event.claims === 1 ? "claim" : "claims"}` : "",
                    ].filter(Boolean);
                    const title = `Checking ${parts.join(" and ") || "the CV"} ${position}`;
                    // A count that would be zero is left out, so the page never says "0 claims".
                    const opened = await journal.open("assess_batch", {
                      batch: event.index + 1, batches: event.total, index: event.index + 1, of: event.total, pass,
                      ...(event.requirements ? { requirements: event.requirements } : {}),
                      ...(event.claims ? { claims: event.claims } : {}),
                    }, title);
                    batchSteps.set(event.index, opened);
                    if (!auditRef.stepId && opened.id) auditRef.stepId = opened.id;
                    return;
                  }
                  if (event.phase === "retry") {
                    // The batch's own call is finished and paid for; the correction is a second charge.
                    const step = batchSteps.get(event.index);
                    if (event.usage) step?.addCost(event.usage);
                    await journal.close(step, "done");
                    batchSteps.delete(event.index);
                    retrySteps.set(event.index, await journal.open("assess_retry",
                      { batch: event.index + 1, index: event.index + 1, pass, ...(event.corrections ? { corrections: event.corrections } : {}) }));
                    return;
                  }
                  // The call is charged what it cost however it ended: done, failed or cancelled.
                  const step = retrySteps.get(event.index) ?? batchSteps.get(event.index);
                  if (event.usage) step?.addCost(event.usage);
                  if (event.phase !== "done") return;
                  retrySteps.delete(event.index);
                  batchSteps.delete(event.index);
                  await journal.close(step, "done");
                },
              });
            });
          ran.push(...audit.batches);
          merged = audit.review;
          total = audit.total;
          for (const result of audit.batches) {
            if (result.status === "done" && result.result) {
              held.set(result.index, result.result);
              // Saved as soon as the audit returns, finished batches only, so a retry re-runs only
              // the batches this attempt lost.
              if (pass === "draft") await runner.save(auditStage(result.index), inputsFor(result.index), result.result);
              continue;
            }
            // A batch that did not finish closes with what ended it: its own failure, or a
            // cancellation because a sibling failed or the run was stopped, which is not a failure.
            const step = retrySteps.get(result.index) ?? batchSteps.get(result.index);
            retrySteps.delete(result.index);
            batchSteps.delete(result.index);
            if (!step) continue;
            if (result.status === "cancelled") {
              await journal.close(step, "skipped", { cancelled: true });
              continue;
            }
            const stopped = batchStop(result, total);
            await journal.close(step, "failed", undefined, {
              error: stopped.message.slice(0, 1000), failure: cvBuildFailureFor(stopped, { attempt, maxAttempts }),
            });
          }
        }
        const failed = ran.find(result => result.status === "failed");
        // The revision's audit is the engine's merge, which puts the memo's verdicts back in place;
        // otherwise, and for an engine that merged nothing, the batches in order.
        const inOrder = Array.from({ length: total }, (_, index) => held.get(index));
        const review: CvReviewPlan | null = (pass === "revision" ? merged : null)
          ?? (inOrder.every(Boolean) ? { matches: inOrder.flatMap(batch => batch!.matches), claims: inOrder.flatMap(batch => batch!.claims) } : null);
        if (failed || !review) {
          if (interrupted) throw interrupted;
          // The batches that finished are saved above; the rest were cancelled because the stage
          // ran past its allowance, not because the assessment could not be finished. That is a
          // stalled stage, which the next attempt resumes from what was saved.
          if (!failed && stageSignal?.aborted && !stop.signal.aborted)
            throw pass === "draft" ? runner.stalled(admission, "assess_batch")
              : new CvBuildStop("stalled", "The re-check ran past its allowance.", { motion: "assess_batch" });
          throw failed ? batchStop(failed, total) : new CvBuildStop("assessment_incomplete", "The assessment did not finish every batch.", { motion: "assess_batch" });
        }
        const assessed = await journal.run("assemble", { pageCount, ...(pass === "revision" ? { pass } : {}) }, async step => {
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
            throw new CvBuildStop("assessment_incomplete", (error as Error).message, { motion: "assemble" });
          }
          step.add(assessmentTally(value.review));
          return value;
        });
        // The verdicts the revision's re-check may reuse: filed under the baseline audit's own route.
        if (pass === "draft")
          await runner.save(claimMemoStage, memoInputs, cvClaimMemoFrom(review, cvClaimMemoKeys(items, await ai.claimMemoRoute("draft"))));
        return assessed;
      };
      /** The failure one batch's result names, as the build throws it. */
      function batchStop(result: CvAssessBatchResult, total: number): CvBuildStop {
        const where = { motion: "assess_batch" as CvBuildMotion, batch: result.index + 1 };
        const note = `(batch ${result.index + 1} of ${total})`;
        // A batch that came back without every requirement or claim it was asked for: the CV is
        // saved, so another assessment of that batch is all that is needed.
        if (result.error === ASSESSMENT_COVERAGE_ERROR) return new CvBuildStop("assessment_incomplete", result.error, where);
        const kind: CvFailureKind = result.failure?.kind ?? "output_invalid";
        return new CvBuildStop(kind, callFailureMessage(kind, REVIEW_CALL, result.failure?.status, note, result.failure?.stall), {
          ...where, ...(result.error ? { cause: result.error.slice(0, 500) } : generationError ? { cause: generationError.slice(0, 500) } : {}),
        });
      }

      let assessment: CvAssessment;
      if (baseline) {
        assessment = baseline;
        await journal.record("assemble", { reused: true }, "skipped");
      } else {
        assessment = await assessContent(content!, "draft", inputs.reusedContent ? inputs.savedPages : undefined);
      }

      // ---- Publication -------------------------------------------------------------------------
      const revision = Math.max(1, draft.revision);
      const publishStep = await journal.open("publish", { revision });
      const archivedPrevious = await archivesPrevious(deps.db, draft);
      const exists = await deps.db.transaction(async tx => {
        await locked.assertOwnership?.(tx as unknown as Db);
        const ok = await completeCv(tx, draftId, {
          status: "ready", buildStage: null, content, assessment, revision,
          // Nothing is left to resume and nothing is left to explain.
          buildCheckpoint: null, failure: null,
        });
        if (!ok) return false;
        // The plan the wording was written against stays beside the assessment, for replay.
        if (tailoringPlan) await saveCvTailoringPlan(tx, draftId, draft.userId, tailoringPlan);
        const spent = await tx.execute<{ spent: number }>(
          sql`select coalesce(sum(cost_usd::float8), 0) as spent from ai_calls where ref_id = ${draftId}`);
        // Closed inside the transaction that makes the CV ready: a page that sees it ready sees it saved.
        await journal.closeWithin(tx as unknown as Db, publishStep, "done", {
          archivedPrevious, reservedUsd: usd(reservedUsd), spentUsd: usd(Number(spent.rows[0]?.spent ?? 0)),
        });
        return true;
      });
      if (!exists) throw new CvDeletedError();
      published = true;
      journal.markPublished();

      // ---- The optional improvement, after publication ----------------------------------------

      /**
       * One optional rewrite towards the evidence the baseline missed, re-checked against the same
       * rubric, and adopted as a new revision only if it is strictly better. The baseline is already
       * the person's CV; nothing here can take it away, and nothing here is a failure of the build.
       */
      const improve = async (args: {
        baselineContent: CvContent;
        baselineAssessment: CvAssessment;
        opportunities: CvAssessment["review"]["matches"];
        semanticTarget: NonNullable<typeof semantic>;
      }) => {
        const keep = (reason: string) => journal.record("adopt_revision", { reason }, "skipped");
        let fitted: Awaited<ReturnType<typeof selectCvToFit>>;
        const opportunities = args.opportunities.length;
        // Opened once the stage is admitted, so its row follows its admission in the narrative.
        const opened: { step?: CvOpenStep<"improve_content"> } = {};
        try {
          fitted = await runner.paid("improve", "improve_content", estimateCvStage("improve", sizes, models), async stageCtx => {
            opened.step = await journal.open("improve_content", { opportunities });
            callSteps.set("improvement", opened.step);
            // The same scale the baseline actually fitted at: a baseline that had to rewrite twice
            // to fit is not improved by a candidate written to the first attempt's larger budget.
            const budget = createCvWritingBudget(library, target, writeScale, args.semanticTarget);
            const plan = requireResult(await ai.buildCv({ library, rubric, tailoringPlan,
              description: draft.jobDescription, jobTitle: draft.jobTitle, company: draft.companyName,
              improvements: args.opportunities.map(item => item.improvement).filter(Boolean),
              writingBudget: budget, maxPages: cvMaxPages(library.theme),
            }, ref("improvement", "cv-author", stageCtx.signal, opened.step?.id)), "improvement", AUTHOR_CALL);
            // Every citation must name a source row that exists and says what it quotes. The
            // optional pass has one call and no correction loop: an unverifiable answer keeps the original.
            try {
              validateCvPlanProvenance(plan, library);
            } catch (error) {
              throw new CvBuildStop("output_invalid", `The written CV's sources could not be verified: ${(error as Error).message}`);
            }
            const omitted = library.entries.filter(entry =>
              (entry.kind === "experience" || entry.kind === "education") &&
              !plan.sections.some(section => section.entryId === entry.id));
            if (omitted.length)
              throw new CvBuildStop("output_invalid", "The optional revision omitted employment or education.");
            // The optional pass strengthens role evidence. Preserve the already checked qualification
            // wording, so retaining an education block cannot conceal the loss of one qualification.
            const baselineQualifications = new Map(CvPlanSchema.parse(args.baselineContent).sections
              .filter(section => library.entries.some(entry => entry.id === section.entryId && entry.kind === "education"))
              .map(section => [section.entryId, section]));
            plan.sections = plan.sections.map(section => baselineQualifications.get(section.entryId) ?? section);
            // One author call only. Deterministic fitting may remove whole lower-value bullets; an
            // unfittable or unsupported candidate is discarded rather than starting another loop.
            const candidate = await selectCvToFit(library, plan, target, budget, args.semanticTarget);
            assertCvPageLimit(candidate.pageCount, cvMaxPages(library.theme));
            return candidate;
          });
          await journal.close(opened.step, "done", { opportunities });
        } catch (error) {
          if (interrupted || error instanceof CvDeletedError) throw interrupted ?? error;
          // Optional polish that did not come off — the call failed, its answer was unusable, or
          // the month could not afford it: the published original stands, which is neutral.
          const reason = keptBecause((error as Error).message);
          if (opened.step) await journal.close(opened.step, "skipped", { kept: true, reason });
          else await journal.record("improve_content", { opportunities, kept: true, reason }, "skipped");
          await journal.record("compare_content", { accepted: false, reasons: ["The optional revision could not be verified; the checked original was retained."] });
          await keep(reason);
          return;
        }
        let candidateAssessment: CvAssessment;
        try {
          candidateAssessment = await assessContent(fitted.content, "revision", fitted.pageCount);
        } catch (error) {
          if (interrupted || error instanceof CvDeletedError) throw interrupted ?? error;
          // The re-check did not finish — refused by the budget, stopped at its allowance, or a
          // batch failed. The CV is ready and stays so: what this pass left open is skipped, never
          // failed, and the narrative ends on the original being kept, with why.
          const reason = keptBecause((error as Error).message);
          await journal.skipOpen(reason);
          await journal.record("compare_content", { accepted: false, reasons: ["The optional revision could not be verified; the checked original was retained."] });
          await keep(reason);
          return;
        }
        const comparison = compareCvQuality(args.baselineAssessment, args.baselineContent, candidateAssessment, fitted.content);
        await journal.record("compare_content", { accepted: comparison.accept, reasons: comparison.reasons });
        if (!comparison.accept) {
          await keep(keptBecause(comparison.reasons[0] ?? "The revision was not strictly stronger."));
          return;
        }
        const adopted = await deps.db.transaction(async tx => {
          await locked.assertOwnership?.(tx as unknown as Db);
          return saveImprovedCvRevision(tx, draftId, { content: fitted.content, assessment: candidateAssessment }, tailoringPlan);
        });
        if (!adopted.adopted) {
          await keep(adopted.reason);
          return;
        }
        await journal.record("adopt_revision", {
          draftId: adopted.id, revisionId: adopted.id, revision: adopted.revision, version: adopted.version,
          label: adopted.name, name: adopted.name,
        });
      };
      const opportunityIds = new Set(diagnoseCvQuality(assessment, content!).evidencedOpportunityGap.requirementIds);
      const opportunities = assessment.review.matches.filter(match => opportunityIds.has(match.requirementId));
      if (semantic && mode !== "assess" && !legacyFenced && opportunities.length > 0)
        await improve({ baselineContent: content!, baselineAssessment: assessment, opportunities, semanticTarget: semantic });
      else if (semantic && !legacyFenced && mode !== "assess")
        await journal.record("improve_content", { opportunities: 0, skipped: true, reason: "No important evidence available in the Library was omitted." }, "skipped");
      return { draftId, ready: true };
    } catch (error) {
      // Something outside the work told this build to stop, and whatever the work then threw is a
      // consequence of that rather than the reason: the interruption is what the person is told.
      const cause = interrupted ?? error;
      // The CV is ready and stays ready. Whatever stopped the optional work after it — a lost
      // lease, a deadline, a draft deleted from under it — ends that work and nothing else.
      if (published) {
        await journal.failOpen(cause instanceof Error ? cause.message : "The optional improvement stopped.");
        log.warn("CV optional improvement stopped after publication", { draftId, error: (cause as Error)?.message });
        return { draftId, ready: true };
      }
      if (cause instanceof CvDeletedError) return { draftId, skipped: true, reason: "deleted" };
      const failure = cvBuildFailureFor(cause, { attempt, maxAttempts, ...(journal.openMotion ? { motion: journal.openMotion } : {}) });
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
      // A finished attempt holds nothing: any hold still recorded for this draft is a dead one.
      if (published) await releaseAiHolds(deps.db, { userId: draft.userId, callSite: "CV", refId: draftId }).catch(() => undefined);
    }
  }, {
    busyMessage: CV_BUSY_MESSAGE,
    // The lease went to another worker, so every write from here would be stale: stop the model
    // calls rather than finish a build whose result nothing will accept.
    onLost: () => stopBuild(new CvBuildStop("worker_interrupted", CV_LOST_PLACE_MESSAGE)),
  });
}

/** The evidence plan, checked against the rubric and the Library it was made for. */
function validatePlan(plan: CvTailoringPlan, input: { rubric: CvRubric; library: Parameters<typeof cvTailoringEvidence>[0] }): CvTailoringPlan {
  try {
    return validateCvTailoringPlan(plan, input.rubric, cvTailoringEvidence(input.library), input.library);
  } catch (error) {
    throw new CvBuildStop("output_invalid", (error as Error).message, { motion: "plan_evidence" });
  }
}

/** What a plan found, for its step. */
function planFigures(plan: CvTailoringPlan) {
  return {
    requirements: plan.requirements.length,
    supported: plan.requirements.filter(item => item.status === "demonstrated" || item.status === "partial").length,
    questions: plan.gapQuestions.length,
  };
}

