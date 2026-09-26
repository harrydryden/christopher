/**
 * What a CV build will cost this account, answered before the button is pressed.
 *
 * The worker admits a build against the account's monthly budget and refuses it with
 * `aiBudgetRefusalMessage` when it does not fit (`apps/worker/src/handlers/cv.ts`). That admission
 * stays the authority — it is taken inside the budget lock, it knows the operator's environment
 * caps, and it measures the snapshot the build actually holds. This is the early answer to the same
 * question, computed from the same figures: the account's recorded spend, the capacity its own
 * calls in flight are holding, its limit, and `estimateCvBuildUsd` over the Library and the role's
 * description as they are now. It exists so the price is shown where the build is chosen, and so a
 * refusal arrives at the button rather than on a CV page after the redirect.
 *
 * Every read here carries the account: the Library, the settings, the spend, the holds, and the
 * role, which is read through this account's `user_jobs` view rather than the shared catalogue.
 */
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { aiReservations, accountAiSpend, cvDrafts, cvLibraries, jobs, userJobs } from "@ava/db";
import {
  aiBudgetRefusalMessage,
  aiBudgetWindowStart,
  CvLibrarySchema,
  DEFAULT_CV_THEME,
  groupCvLibrary,
} from "@ava/core";
// The one estimator the worker admits builds with, so the price quoted here and the price held
// there cannot drift. The interface does not depend on `@ava/ai` by name — the worker it
// drives does — and this module is the package's pure pricing table, with no imports of its own.
import { estimateCvBuildUsd, estimateStage, type CvBuildParts, type CvBuildSize } from "../../../packages/ai/src/pricing";
import { CV_REVIEW_BATCH_SIZE, PROMPTS } from "../../../packages/ai/src/prompt-registry";
import type { CvBuildStageName } from "@ava/core";
import { db } from "@/lib/db";
import { formatUsd } from "@/lib/format";
import { getSettingsFor } from "@/lib/settings";

/** What one build is expected to cost, against what this account has left this month. */
export interface CvBuildQuote {
  /** `estimateCvBuildUsd` over this Library and this description, for a build from nothing. */
  estimateUsd: number;
  /** Recorded spend inside the account's budget window. */
  spentUsd: number;
  /** Capacity this account's own calls in flight are holding. */
  heldUsd: number;
  /**
   * What this account's builds still waiting in the queue are expected to cost. They hold nothing
   * until the worker admits them, and a button that ignored them offered a build the worker would
   * refuse once the queue ahead of it had spent its share.
   */
  queuedUsd: number;
  /**
   * What this account's builds already running are still expected to spend beyond what they hold.
   * The worker admits one stage at a time, so a generating build holds only the stage it is in;
   * the stages after it will each be admitted in turn, and are as good as spent.
   */
  inFlightUsd: number;
  /** The account's monthly budget. */
  limitUsd: number;
  /** What is left of it: the limit less spend, holds, queued builds and running builds' remaining stages, never below zero. */
  leftUsd: number;
  /** The sentence the worker would refuse with, or null when the estimate fits. */
  refusal: string | null;
  /** The measured size of the evidence the build would be written from. */
  libraryBytes: number;
  /**
   * Whether this account has a Library at all. A price is not the answer for an account that has
   * saved nothing to write from: its first step is the Library, not the budget, and a caller that
   * offers a build needs to tell the two apart.
   */
  hasLibrary: boolean;
}

/**
 * The bytes the worker measures: the grouped Library with this account's writing preferences and
 * theme, which is exactly the snapshot `requestCv` stores on the draft.
 *
 * A Library that cannot be grouped — nothing active, nothing confirmed — is measured as it stands.
 * The refusal the person needs in that case is the Library's own, raised by `requestCv`; quoting
 * zero for it would say the build is free.
 */
function libraryBytesFor(content: unknown, writingPreferences: unknown, theme: unknown): number {
  if (!content) return 0;
  const measured = (value: unknown) => Buffer.byteLength(JSON.stringify(value ?? null));
  try {
    const library = CvLibrarySchema.parse({
      ...(content as object),
      ...((writingPreferences as object | undefined) ?? {}),
      theme: theme ?? (content as { theme?: unknown }).theme ?? DEFAULT_CV_THEME,
    });
    return measured(groupCvLibrary(library));
  } catch {
    return measured(content);
  }
}

/** The columns of a queued draft its expected cost is measured from. */
export interface QueuedCvDraft {
  model: string;
  libraryBytes: number;
  descriptionBytes: number;
  hasContent: boolean;
  checkpoint: { tailoringEnabled?: boolean; quizCompleted?: boolean; improvementAttempted?: boolean; contentAt?: string; mode?: string } | null;
}

/**
 * What a queued draft's build will pay for, chosen the way the worker chooses it at admission: saved
 * wording is assessed (with the optional revision still to come for a tailored build that has not
 * tried it); a build without wording plans and writes, and a continuation after the quiz does not
 * pay for the planning it already did.
 */
export function queuedDraftParts(draft: Pick<QueuedCvDraft, "hasContent" | "checkpoint">): CvBuildParts {
  const checkpoint = draft.checkpoint ?? {};
  if (draft.hasContent)
    return checkpoint.tailoringEnabled && !checkpoint.improvementAttempted && checkpoint.contentAt ? "tailored_assessment" : "assessment";
  if (checkpoint.tailoringEnabled || checkpoint.mode === "improve") return checkpoint.quizCompleted ? "tailored_completion" : "tailored";
  return "all";
}

/** The expected cost of every build this account has waiting in the queue. */
async function queuedBuildsUsd(userId: string): Promise<number> {
  const rows = await db()
    .select({
      model: cvDrafts.model,
      libraryBytes: sql<number>`octet_length(${cvDrafts.librarySnapshot}::text)::int`,
      descriptionBytes: sql<number>`octet_length(${cvDrafts.jobDescription})::int`,
      hasContent: sql<boolean>`${cvDrafts.content} is not null`,
      checkpoint: sql<QueuedCvDraft["checkpoint"]>`${cvDrafts.buildCheckpoint}`,
    })
    .from(cvDrafts)
    .where(and(eq(cvDrafts.userId, userId), eq(cvDrafts.status, "queued"), isNull(cvDrafts.archivedAt)))
    // Guarded: a database without the checkpoint column prices every queued build as a whole one.
    .catch(async () =>
      (await db()
        .select({
          model: cvDrafts.model,
          libraryBytes: sql<number>`octet_length(${cvDrafts.librarySnapshot}::text)::int`,
          descriptionBytes: sql<number>`octet_length(${cvDrafts.jobDescription})::int`,
          hasContent: sql<boolean>`${cvDrafts.content} is not null`,
        })
        .from(cvDrafts)
        .where(and(eq(cvDrafts.userId, userId), eq(cvDrafts.status, "queued"), isNull(cvDrafts.archivedAt)))).map((row) => ({ ...row, checkpoint: null })),
    );
  return rows.reduce(
    (sum, row) =>
      sum + estimateCvBuildUsd(row.model, { libraryBytes: Number(row.libraryBytes ?? 0), descriptionBytes: Number(row.descriptionBytes ?? 0) }, queuedDraftParts(row)),
    0,
  );
}

/** What a running build's checkpoint says it has already paid for, as the quote needs it. */
export interface GeneratingCvDraft {
  model: string;
  libraryBytes: number;
  descriptionBytes: number;
  /** The keys of `buildCheckpoint.stages`: `rubric`, `plan`, `write`, `audit[0]`, … */
  stageKeys: string[];
  /** The version 1 mirrors the worker writes beside them. */
  hasRubric: boolean;
  hasPlan: boolean;
  hasContent: boolean;
  /** The rubric's requirement count, which decides how many audit batches there will be. */
  requirements: number | null;
  tailoringEnabled: boolean;
  mode: string | null;
  improvementAttempted: boolean;
  /** What this draft's own reservations hold now: the stage it is running. */
  heldUsd: number;
}

// The same sizing as the worker's `estimateCvStage` (`apps/worker/src/handlers/cv-stages.ts`), which
// the interface cannot import: keep the two in step.
const PRINTED_CV_BYTES = 9_000;
const WRITER_TAIL_BYTES = 6_000;
const AUDIT_TAIL_BYTES = 7_500;
const roleBytes = (size: CvBuildSize) => size.descriptionBytes * 2 + 4_000;

/** One stage's expected cost, as the worker admits it. */
function stageUsd(stage: CvBuildStageName, size: CvBuildSize, model: string, batches = 1): number {
  const priced = { cvModel: model };
  switch (stage) {
    case "rubric":
      return estimateStage(PROMPTS["cv.rubric"], { tailBytes: size.descriptionBytes }, priced);
    case "plan":
      return estimateStage(PROMPTS["cv.planning"], { tailBytes: size.libraryBytes + roleBytes(size) }, priced);
    case "write":
      return estimateStage(PROMPTS["cv.author"], { stableBytes: [size.libraryBytes, roleBytes(size)], tailBytes: WRITER_TAIL_BYTES, calls: 3 }, priced);
    case "improve":
      return estimateStage(PROMPTS["cv.improvement"], { stableBytes: [size.libraryBytes, roleBytes(size)], tailBytes: WRITER_TAIL_BYTES }, priced);
    case "audit":
    case "reaudit":
      return estimateStage(PROMPTS[stage === "audit" ? "cv.review" : "cv.review_candidate"], {
        stableBytes: [size.libraryBytes, PRINTED_CV_BYTES], tailBytes: AUDIT_TAIL_BYTES, calls: Math.max(1, batches),
      }, priced);
  }
}

/**
 * What a generating build is still expected to spend beyond what it holds: every stage its
 * checkpoint does not have yet — the rubric, the evidence plan for a tailored build, the writing,
 * the audit batches not yet saved, and the optional improvement and its re-check after publication
 * — less the hold of the stage it is running, which the quote already counts as held.
 */
export function generatingDraftRemainingUsd(draft: GeneratingCvDraft): number {
  const size = { libraryBytes: draft.libraryBytes, descriptionBytes: draft.descriptionBytes };
  const has = (key: string) => draft.stageKeys.includes(key);
  const stages: Array<[CvBuildStageName, number?]> = [];
  if (!has("rubric") && !draft.hasRubric) stages.push(["rubric"]);
  if (draft.tailoringEnabled && !has("plan") && !draft.hasPlan) stages.push(["plan"]);
  if (draft.mode !== "assess" && !has("write") && !draft.hasContent) stages.push(["write"]);
  const expected = draft.requirements ? Math.ceil(draft.requirements / CV_REVIEW_BATCH_SIZE) : 1;
  const held = draft.stageKeys.filter((key) => key.startsWith("audit[")).length;
  if (expected - held > 0) stages.push(["audit", expected - held]);
  if (draft.mode !== "assess" && !draft.improvementAttempted) stages.push(["improve"], ["reaudit"]);
  const remaining = stages.reduce((sum, [stage, batches]) => sum + stageUsd(stage, size, draft.model, batches), 0);
  return Math.max(0, remaining - draft.heldUsd);
}

/** The remaining stages of every build this account has running. */
async function generatingBuildsUsd(userId: string, now: Date): Promise<number> {
  const checkpoint = sql`(case when jsonb_typeof(${cvDrafts.buildCheckpoint}) = 'object' then ${cvDrafts.buildCheckpoint} else '{}'::jsonb end)`;
  const rows = await db()
    .select({
      model: cvDrafts.model,
      libraryBytes: sql<number>`octet_length(${cvDrafts.librarySnapshot}::text)::int`,
      descriptionBytes: sql<number>`octet_length(${cvDrafts.jobDescription})::int`,
      stageKeys: sql<string[]>`(select coalesce(array_agg(k), '{}') from jsonb_object_keys(case when jsonb_typeof(${checkpoint}->'stages') = 'object' then ${checkpoint}->'stages' else '{}'::jsonb end) k)`,
      hasRubric: sql<boolean>`${checkpoint} ? 'rubric'`,
      hasPlan: sql<boolean>`${checkpoint} ? 'tailoringPlan'`,
      hasContent: sql<boolean>`${checkpoint} ? 'contentAt'`,
      requirements: sql<number | null>`case when jsonb_typeof(${checkpoint}->'rubric'->'requirements') = 'array' then jsonb_array_length(${checkpoint}->'rubric'->'requirements') end`,
      tailoringEnabled: sql<boolean>`coalesce((${checkpoint}->>'tailoringEnabled')::boolean, false)`,
      mode: sql<string | null>`${checkpoint}->>'mode'`,
      improvementAttempted: sql<boolean>`coalesce((${checkpoint}->>'improvementAttempted')::boolean, false)`,
      heldUsd: sql<number>`(select coalesce(sum(r.amount), 0)::float8 from ai_reservations r where r.ref_id = cv_drafts.id::text and r.expires_at > ${now})`,
    })
    .from(cvDrafts)
    .where(and(eq(cvDrafts.userId, userId), eq(cvDrafts.status, "generating"), isNull(cvDrafts.archivedAt)))
    // A database without the checkpoint column: nothing to measure the remaining stages from.
    .catch(() => []);
  return rows.reduce(
    (sum, row) =>
      sum + generatingDraftRemainingUsd({
        ...row,
        libraryBytes: Number(row.libraryBytes ?? 0),
        descriptionBytes: Number(row.descriptionBytes ?? 0),
        requirements: row.requirements === null ? null : Number(row.requirements),
        heldUsd: Number(row.heldUsd ?? 0),
      }),
    0,
  );
}

/**
 * What building a CV for this role would cost the account, and whether its budget admits it.
 *
 * An account with no Library, or a role with no stored description, still gets a quote: the
 * missing side measures zero, which is what a build of it would send. The refusal is the account's
 * monthly budget alone; the deployment's optional day and discovery caps live in the worker's
 * environment and are its to apply.
 */
export async function cvBuildQuote(
  userId: string,
  jobId: string,
  now: Date = new Date(),
  /** A description the person pasted, which is what the build will be written against. */
  options: { description?: string } = {},
): Promise<CvBuildQuote> {
  const database = db();
  const settings = await getSettingsFor(userId);
  const [library] = await database
    .select({ content: cvLibraries.content })
    .from(cvLibraries)
    .where(eq(cvLibraries.userId, userId))
    .orderBy(desc(cvLibraries.version))
    .limit(1);
  // The role as this account sees it. A role outside its table quotes on the Library alone rather
  // than reading the shared catalogue without an account behind the read.
  const [role] = await database
    .select({ description: jobs.descriptionText })
    .from(userJobs)
    .innerJoin(jobs, eq(jobs.id, userJobs.jobId))
    .where(and(eq(userJobs.userId, userId), eq(jobs.id, jobId)))
    .limit(1);
  const size: CvBuildSize = {
    libraryBytes: libraryBytesFor(library?.content, settings.cvWritingPreferences, settings.cvTheme),
    descriptionBytes: options.description?.trim()
      ? Buffer.byteLength(options.description.trim())
      : role?.description
        ? Buffer.byteLength(role.description)
        : 0,
  };
  const estimateUsd = estimateCvBuildUsd(settings.cvModel, size, "tailored");
  const since = aiBudgetWindowStart(now, settings.aiBudgetResetAt);
  const [spentUsd, heldUsd, queuedUsd, inFlightUsd] = await Promise.all([
    accountAiSpend(database, userId, since),
    // Holds that have expired are capacity nothing can still be spending; the worker deletes them
    // inside the budget lock, and a quote read a moment before that must not count them either.
    database
      .select({ held: sql<number>`coalesce(sum(amount), 0)::float8` })
      .from(aiReservations)
      .where(and(eq(aiReservations.userId, userId), gt(aiReservations.expiresAt, now)))
      .then((rows) => Number(rows[0]?.held ?? 0)),
    queuedBuildsUsd(userId),
    generatingBuildsUsd(userId, now),
  ]);
  const limitUsd = settings.aiBudgetUsd;
  // Builds waiting in the queue will hold their share the moment the worker admits them, and a
  // running build will admit each of its remaining stages in turn.
  const committed = heldUsd + queuedUsd + inFlightUsd;
  const fits = spentUsd + committed + estimateUsd <= limitUsd;
  const refusal = fits
    ? null
    : aiBudgetRefusalMessage("This build", estimateUsd, { limit: "account", limitUsd, spent: spentUsd, held: committed });
  return {
    estimateUsd,
    spentUsd,
    heldUsd,
    queuedUsd,
    inFlightUsd,
    limitUsd,
    leftUsd: Math.max(0, limitUsd - spentUsd - committed),
    // The worker's sentence says "held by calls in flight", which is all it counts; this figure
    // also counts builds still to be admitted, so it says so.
    refusal: refusal && committed > heldUsd ? refusal.replace(" held by calls in flight", " held by builds queued or in flight") : refusal,
    libraryBytes: size.libraryBytes,
    hasLibrary: !!library,
  };
}

/** The price beside the button: "about $3.10 of your $18.40 left this month". */
export function cvQuoteLine(quote: CvBuildQuote): string {
  return `about ${formatUsd(quote.estimateUsd)} of your ${formatUsd(quote.leftUsd)} left this month`;
}

/** The same price inside a button's own label, where the sentence has to be short: "about $3.10 of $18.40 left". */
export function cvQuoteButtonLine(quote: CvBuildQuote): string {
  return `about ${formatUsd(quote.estimateUsd)} of ${formatUsd(quote.leftUsd)} left`;
}

/** What each of the editor's two actions is expected to cost for one saved revision. */
export interface CvEditCosts {
  /** Save Direct Edits: the saved wording is kept, so only the assessment is paid for again. */
  assessmentUsd: number;
  /** Rebuild from Library: plans, writes and checks, with capacity for one useful improvement. */
  allUsd: number;
}

/**
 * The two figures under the editor's buttons, from the same estimator the worker admits with.
 *
 * `assessment` is what a resumed build pays for — the wording is already written — which is what
 * Save Direct Edits asks the worker to do; `all` is a build from nothing, which is what Rebuild
 * from Library asks for.
 */
export function cvEditCosts(model: string, size: CvBuildSize): CvEditCosts {
  return {
    assessmentUsd: estimateCvBuildUsd(model, size, "assessment"),
    allUsd: estimateCvBuildUsd(model, size, "tailored_completion"),
  };
}

/** The size of one saved revision: the evidence it holds and the advert it was written against. */
export function cvDraftSize(draft: { librarySnapshot: unknown; jobDescription: string }): CvBuildSize {
  return {
    libraryBytes: Buffer.byteLength(JSON.stringify(draft.librarySnapshot ?? null)),
    descriptionBytes: Buffer.byteLength(draft.jobDescription ?? ""),
  };
}
