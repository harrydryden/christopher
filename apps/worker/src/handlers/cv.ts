import { buildFittedCv, CvFitFailure } from "@christopher/core/cv-fit";
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
  type CvAssessment,
  type CvReviewPlan,
} from "@christopher/core/cv-assessment";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { completeCv, cvRoleKey, schema, type Task, type Db } from "@christopher/db";
import { createAiEngine, estimateCvBuildUsd, CANCELLED_ERROR, type AiFailure, type AiUsageRecord } from "@christopher/ai";
import {
  CvContentSchema,
  CvPlanSchema,
  CvLibrarySchema,
  CV_BUILD_MOTIONS,
  aiBudgetWindowStart,
  cvBuildFailure,
  cvMaxPages,
  cvRelevanceTerms,
  groupCvLibrary,
  type CvBuildCheckpoint,
  type CvBuildFailure,
  type CvFailureKind,
} from "@christopher/core";
import { withResourceLease } from "../lease";
import { tryReserveAi, type AiBudgetRefusal } from "../budget";
import { backoffMs } from "../queue";
import { CvJournal, type CvOpenStep } from "./cv-journal";
import type { WorkerDeps } from "../context";
import { log } from "../log";

class CvDeletedError extends Error {}

/**
 * A failure that already knows what it is.
 *
 * Everything the build can be stopped by is either thrown as one of these, at the point that knows
 * which motion it was and what the model said, or is a class the catch can recognise. Nothing is
 * classified by reading English out of an error message, because the sentences that matter come
 * from a provider that is free to reword them.
 */
export class CvBuildStop extends Error {
  constructor(
    readonly kind: CvFailureKind,
    message: string,
    readonly extra: Partial<CvBuildFailure> = {},
  ) {
    super(message);
    this.name = "CvBuildStop";
  }
}

/**
 * Thrown when the system is going to resolve the failure itself: the queue re-queues the task with
 * its usual backoff, and the next attempt resumes from the build's checkpoint rather than paying
 * for the rubric and the writing again. The draft stays `generating` with `failure` explaining
 * the wait, so the page says what happened and when it will be tried again.
 */
export class CvRetryableBuildError extends Error {
  constructor(message: string, readonly failure: CvBuildFailure) {
    super(message);
    this.name = "CvRetryableBuildError";
  }
}

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
 * Which source supplied a rubric this build does not have to pay for, named so the narrative can
 * say which. A checkpoint comes first: it is this build's own earlier attempt, already validated
 * against this description, and the cheapest thing a retry can skip.
 */
export function reusedCvRubric(
  draft: RubricSource & { buildCheckpoint?: CvBuildCheckpoint | null },
  parent: RubricSource | undefined,
  supplied: unknown,
): { reused: "checkpoint" | "parent" | "assessment"; rubric: unknown } | null {
  if (draft.buildCheckpoint?.rubric) return { reused: "checkpoint", rubric: draft.buildCheckpoint.rubric };
  // A rubric on the task is the parent revision's, carried so that retention deleting the parent
  // cannot move the goalposts; to the reader it is the same thing as the parent's own.
  const inherited = reusableCvRubric(draft, parent, supplied);
  if (!inherited) return null;
  return { reused: inherited === draft.assessment?.rubric && !supplied ? "assessment" : "parent", rubric: inherited };
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
  "status" | "content" | "assessment" | "revision" | "buildStage" | "error" | "finalisedAt" | "progressAt" | "buildCheckpoint" | "failure">>;

/** Money as the narrative shows it: enough precision for a batch that cost a fifth of a cent. */
const usd = (value: number) => Number(value.toFixed(4));

/** What a call consumed, for the step that made it. Tokens are every token it was billed for. */
function callCost(usage: AiUsageRecord | undefined): Record<string, number> {
  if (!usage) return {};
  return {
    usd: usd(usage.costUsd),
    tokens: usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
  };
}

/** What this account has spent and has in flight. Reported only: `tryReserveAi` is what decides. */
async function accountBudgetSnapshot(db: Db, userId: string, since: Date): Promise<{ spent: number; held: number }> {
  const rows = await db.execute<{ spent: number; held: number }>(sql`select
    (select coalesce(sum(cost_usd::float8), 0) from ai_calls where user_id = ${userId} and at >= ${since}) as spent,
    (select coalesce(sum(amount::float8), 0) from ai_reservations where user_id = ${userId}) as held`);
  return { spent: Number(rows.rows[0]?.spent ?? 0), held: Number(rows.rows[0]?.held ?? 0) };
}

/** Whether publishing this build will archive a CV that is currently the saved one for its role. */
async function archivesPrevious(db: Db, draft: { id: string; userId: string; companyName: string; jobTitle: string }): Promise<boolean> {
  const rows = await db.select({ id: schema.cvDrafts.id }).from(schema.cvDrafts).where(and(
    sql`${cvRoleKey(schema.cvDrafts.userId, schema.cvDrafts.companyName, schema.cvDrafts.jobTitle)} = ${cvRoleKey(draft.userId, draft.companyName, draft.jobTitle)}`,
    eq(schema.cvDrafts.status, "ready"), isNull(schema.cvDrafts.archivedAt), ne(schema.cvDrafts.id, draft.id),
  )).limit(1);
  return rows.length > 0;
}

/** The assessment in one line of figures: how the requirements landed and how the claims held up. */
function assessmentTally(review: CvReviewPlan): Record<string, number> {
  const count = <T extends string>(values: T[], value: T) => values.filter(item => item === value).length;
  const matches = review.matches.map(match => match.status);
  const claims = review.claims.map(claim => claim.status);
  return {
    demonstrated: count(matches, "demonstrated"), partial: count(matches, "partial"),
    missing: count(matches, "missing"), unknown: count(matches, "unknown"),
    supported: count(claims, "supported"), unsupported: count(claims, "unsupported"),
    uncertain: count(claims, "uncertain"),
  };
}

/** What a call was doing, in the two grammars the failure sentences need. */
type Doing = { gerund: string; step: string };
const RUBRIC_CALL: Doing = { gerund: "extracting the role's requirements", step: "requirements" };
const AUTHOR_CALL: Doing = { gerund: "writing the CV", step: "writing" };
const REVIEW_CALL: Doing = { gerund: "checking the CV against your evidence", step: "assessment" };

/**
 * One plain sentence for a model call that did not produce a usable answer, with the figures that
 * matter. The kind is what the system acts on; this is what the person reads.
 */
function callFailureMessage(kind: CvFailureKind, doing: Doing, status?: number, note?: string): string {
  const where = ` while ${doing.gerund}`;
  switch (kind) {
    case "rate_limited":
      return `The model provider asked us to slow down${where}.`;
    case "overloaded":
      return `The model provider was overloaded${where}${status ? ` (HTTP ${status})` : ""}.`;
    case "connection":
      return `The connection to the model provider dropped${where}.`;
    case "stalled":
      return `The model stopped responding${where}: nothing arrived for fifteen minutes.`;
    case "model_access":
      return `The CV model could not be reached${where}${status ? ` (HTTP ${status})` : ""}. Check model access and usage in Health, then retry.`;
    case "output_limit":
      return `The model ran out of room for its answer${where}${note ? ` ${note}` : ""}.`;
    case "refused":
      return `The model declined to answer${where}${note ? ` ${note}` : ""}.`;
    default:
      return `The model's answer to the ${doing.step} step could not be used${note ? ` ${note}` : ""}.`;
  }
}

/** Asked of the person once the system has tried again and met the same thing. */
const OUTPUT_LIMIT_ASK =
  "The model ran out of room for its answer twice. Choose a more capable CV model in Settings, then rebuild this CV.";
const REFUSED_ASK =
  "The model declined this request twice. Check the job description for anything it may have objected to, then rebuild this CV.";

/** A build that ends without a lease is a build whose writes would be stale; nothing else is wrong. */
const LEASE_LOST = "lease lost; refusing stale writes";

/**
 * What stopped the build, in the taxonomy the page and the queue both read.
 *
 * Everything that carries its own kind is taken at its word. The rest are recognised by class:
 * the fitter's three ways of giving up, an over-long layout, and a lease this worker no longer
 * holds. Anything else is honestly `unknown`, which asks the person rather than burning retries
 * on something nobody has understood yet.
 */
function classifyBuildFailure(error: unknown): { kind: CvFailureKind; message: string; extra: Partial<CvBuildFailure> } {
  if (error instanceof CvBuildStop) return { kind: error.kind, message: error.message, extra: error.extra };
  if (error instanceof CvFitFailure) {
    if (error.kind === "page_limit") {
      const pages = error.detail.pages ?? 0;
      const maxPages = error.detail.maxPages ?? 0;
      return {
        kind: "page_limit_unfittable",
        message: `The CV is ${pages} ${pages === 1 ? "page" : "pages"} after three attempts; the limit is ${maxPages}. Remove some evidence in your Library or raise the page limit in Settings.`,
        extra: {},
      };
    }
    if (error.kind === "skill_format")
      // Three attempts have already been spent on this inside one build. A fourth from a fresh
      // task would meet the same model and the same library, so the person chooses instead.
      return { kind: "output_invalid", message: error.message, extra: { resolvedBy: "user", retryable: false, action: "choose_model" } };
    return { kind: "output_invalid", message: error.message, extra: {} };
  }
  if (error instanceof CvLayoutError) return { kind: "page_limit_unfittable", message: error.message, extra: {} };
  // Our own sentence, not a provider's: the lease fence raises a plain Error either way it is lost.
  if (error instanceof Error && error.message.endsWith(LEASE_LOST))
    return { kind: "worker_interrupted", message: "This build lost its place to another worker before it finished.", extra: {} };
  const detail = error instanceof Error && !error.message.startsWith("Failed query:")
    ? error.message : "Could not complete this CV. Please retry.";
  return { kind: "unknown", message: detail, extra: {} };
}

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
    const [draft] = await deps.db
      .select()
      .from(schema.cvDrafts)
      .where(eq(schema.cvDrafts.id, draftId));
    if (!draft || draft.status === "ready") return { skipped: true };

    // A queued row always carries both; a hand-made task in a test may not, and an attempt that
    // is not a number would reach the ledger as a broken row.
    const attempt = Number.isFinite(task.attempts) ? Math.max(1, task.attempts) : 1;
    const maxAttempts = Number.isFinite(task.maxAttempts) ? task.maxAttempts : attempt;
    let release: (() => Promise<void>) | undefined;
    let renewHold: (() => Promise<void>) | undefined;
    // Every motion of this attempt, written as it happens. A step closing is also the moment the
    // build's reservation is renewed: it is the one event that is always genuine progress.
    const journal = new CvJournal({
      db: deps.db, draftId, userId: draft.userId, taskId: task.id ?? null, attempt, now: deps.now,
      onClose: async () => { await renewHold?.(); },
    });
    // What this build has already paid for. A retry reads it and skips those calls; publication
    // clears it, because a published CV has nothing left to resume.
    let checkpoint: CvBuildCheckpoint = draft.buildCheckpoint ?? {};
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
      const since = aiBudgetWindowStart(deps.now(), account.aiBudgetResetAt);
      await journal.run("admit_budget", { expectedUsd: usd(expected), limitUsd: account.aiBudgetUsd }, async step => {
        const before = await accountBudgetSnapshot(deps.db, draft.userId, since);
        const hold = await tryReserveAi(deps.db, "CV", expected, {
          account: { userId: draft.userId, budgetUsd: account.aiBudgetUsd, since },
          daily: deps.env.dailyAiBudgetUsd ?? 1000000,
          discovery: deps.env.discoveryAiBudgetUsd ?? 1000000,
          workerId: deps.env.workerId,
        }, deps.now(), 30);
        if ("refused" in hold) {
          step.add({ limitUsd: hold.refused.limitUsd, heldUsd: usd(hold.refused.held),
            leftUsd: usd(Math.max(0, hold.refused.limitUsd - hold.refused.spent - hold.refused.held)) });
          throw new CvBuildStop("budget_exhausted", budgetRefusal(expected, hold.refused));
        }
        release = hold.release;
        renewHold = hold.renew;
        step.add({ heldUsd: usd(before.held + expected),
          leftUsd: usd(Math.max(0, account.aiBudgetUsd - before.spent - before.held - expected)) });
      });
      const stage = async (buildStage: NonNullable<BuildUpdate["buildStage"]>) => {
        await save({ buildStage });
        await renewHold?.();
      };
      const ai = createAiEngine({
        apiKey: deps.env.anthropicApiKey,
        client: deps.aiClient,
        getModel: () => draft.model,
        onUsage: async ({ failure, ...usage }) => {
          // The failure that ended a build is the one to report: not a batch cancelled because of
          // it, and not a sibling that happened to finish cleanly afterwards.
          if (usage.error && usage.error !== CANCELLED_ERROR) generationError = usage.error;
          if (usage.stage) {
            callUsage.set(usage.stage, { ...usage, ...(failure ? { failure } : {}) });
            if (failure) callFailures.set(usage.stage, failure);
          }
          // `failure` is the same event named; `ai_calls` keeps the text it always kept.
          await deps.db.insert(schema.aiCalls).values({ ...usage, userId: draft.userId });
        },
      });
      /**
       * A call that produced nothing usable, named by what the engine recorded for it rather than
       * by whichever error happened to be most recent. `note` carries the figures the sentence
       * needs, such as which of the three writing attempts this was.
       */
      const requireResult = <T>(value: T | null, stage: string, doing: Doing, note?: string): T => {
        if (value) return value;
        const failure = callFailures.get(stage) ?? (stage === "review" ? callFailures.get("review_retry") : undefined);
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

      let content = inputs.reusedContent ? inputs.saved : undefined;
      if (!content) {
        let writeStep: CvOpenStep | null = null;
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
                    ...input,
                  },
                  { refType: "cv-author", refId: draft.id, stage: "author", userId: draft.userId },
                ),
                "author", AUTHOR_CALL, `(attempt ${writeAttempt} of 3)`,
              ),
            initial,
            async (event) => {
              if (typeof event === "string") {
                await stage(event);
                return;
              }
              switch (event.motion) {
                case "write":
                  if (event.phase === "start") {
                    writeAttempt = event.attempt;
                    writeStep = await journal.open("write", {
                      attempt: event.attempt, budgetCharacters: event.budgetCharacters,
                      budgetScale: event.budgetScale, maxPages: event.maxPages,
                    }, event.attempt > 1 ? CV_BUILD_MOTIONS.rewrite.title : undefined);
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
      await stage("assessing");
      const { pageCount, maxPages } = await renderCvPdfWithReport(content!);
      // A build that skipped the writer never measured anything, so its one measurement is here.
      if (inputs.reusedContent) await journal.record("measure", { pages: pageCount, maxPages });
      assertCvPageLimit(pageCount, maxPages);
      const batchSteps = new Map<number, CvOpenStep>();
      const retrySteps = new Map<number, CvOpenStep>();
      const requirementsPerBatch = (total: number) => Math.max(1, Math.ceil(rubric.requirements.length / total));
      let review: CvReviewPlan;
      try {
        review = requireResult(
          await ai.assessCv(
            {
              rubric,
              cv: cvTextItems(content!),
              claims: cvClaimItems(content!),
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
                  await journal.close(retry, status, { usd: usd(event.usage?.costUsd ?? 0) });
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
      const assessment = await journal.run("assemble", { pageCount }, async step => {
        let value: CvAssessment;
        try {
          value = createCvAssessment({
            content: content!,
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
      if (error instanceof CvDeletedError) return { draftId, skipped: true, reason: "deleted" };
      const base = classifyBuildFailure(error);
      let message = base.message;
      let extra: Partial<CvBuildFailure> = { ...base.extra, attempt, maxAttempts };
      // Two failures change hands with repetition rather than being one thing always. A model that
      // ran out of room, or declined, is worth one more attempt by the system — the second time it
      // is the person who has to choose a different model or reword the role, because a third
      // attempt would meet the same model with the same prompt and cost the same money.
      if (base.kind === "output_limit" || base.kind === "refused") {
        const ask = attempt >= 2;
        extra = ask
          ? { ...extra, resolvedBy: "user", retryable: false, action: base.kind === "output_limit" ? "choose_model" : "retry" }
          : { ...extra, resolvedBy: "system", retryable: true };
        if (ask) message = base.kind === "output_limit" ? OUTPUT_LIMIT_ASK : REFUSED_ASK;
      }
      // Operations reads the raw reason; the person never does. Kept whenever the sentence we show
      // is not the sentence that was thrown, such as a page limit reported in the reader's terms.
      if (!extra.cause && error instanceof Error && error.message !== message)
        extra = { ...extra, cause: error.message.slice(0, 500) };
      const failure = cvBuildFailure(base.kind, message, extra);
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
        throw new CvRetryableBuildError(message, retrying);
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
      await release?.();
    }
  });
}
