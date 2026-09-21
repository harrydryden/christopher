/**
 * Review one account's evidence library: how much each entry actually evidences, and what to ask
 * for next.
 *
 * Three things shape this handler.
 *
 * The deterministic baseline is written before anything is asked of a model, so the Library has a
 * score the moment someone saves it — and keeps one for an account whose budget is spent, whose
 * deployment has no key, or whose pass fails. `rulesLibraryReview` reads only the person's own
 * facet tags, so it costs nothing and cannot be wrong about what they wrote.
 *
 * Only entries whose wording changed are sent. `libraryEntryInputHash` covers an entry's rows,
 * their facets and the job it belongs to and nothing version-scoped, so fixing one typo re-reviews
 * one entry and every other entry carries its last review into the new version.
 *
 * The pass is admitted against the account's own monthly budget once, up front, exactly as a CV
 * build is, and a refusal finishes the task rather than failing it: work an exhausted account
 * cannot pay for must not fill Health with retries nothing can complete.
 */
import {
  aiBudgetRefusalMessage,
  aiBudgetWindowStart,
  aiFeatureLabel,
  isActiveStoredEvidence,
  libraryEntryInputHash,
  reviewableRows,
  rulesLibraryReview,
  usd,
  type CvLibrary,
  type Employment,
  type TaskPayloads,
} from "@christopher/core";
import { createAiEngine, estimateLibraryReviewUsd } from "@christopher/ai";
import {
  latestLibraryReviews,
  pruneLibraryReviews,
  recordAiCall,
  schema,
  upsertLibraryReviews,
  type Db,
  type LibraryReviewUpsert,
  type Task,
} from "@christopher/db";
import { desc, eq } from "drizzle-orm";
import { tryReserveAi } from "../budget";
import type { TaskRunContext } from "../queue";
import type { WorkerDeps } from "../context";
import { log } from "../log";

/** Entry kinds an evidence review is about. An interests block is not evidence of anything. */
const REVIEWABLE_KINDS = new Set(["experience", "education", "skill"]);

type CvEntry = CvLibrary["entries"][number];

/** How long the pass may hold its share of the month: the task's deadline, with room to spare. */
const HOLD_MINUTES = 10;

export async function handleReviewLibrary(task: Task, deps: WorkerDeps, ctx?: TaskRunContext): Promise<unknown> {
  const { userId, libraryVersion } = (task.payload ?? {}) as TaskPayloads["review_library"];
  if (!userId) return { skipped: "no account on task" };

  // The dedupe key is the account, so a burst of saves runs once — for whatever is there when it
  // runs, which is the newest version rather than the one the first save happened to name.
  const [library] = await deps.db
    .select({ version: schema.cvLibraries.version, content: schema.cvLibraries.content })
    .from(schema.cvLibraries)
    .where(eq(schema.cvLibraries.userId, userId))
    .orderBy(desc(schema.cvLibraries.version))
    .limit(1);
  if (!library) return { skipped: "no library saved" };
  const version = library.version;
  /** Named only when it is not the version the save asked for, so the result says what was read. */
  const newer = typeof libraryVersion === "number" && version > libraryVersion
    ? { requestedVersion: libraryVersion, reviewedVersion: version }
    : {};

  const employmentOf = (entry: CvEntry): Employment | null =>
    library.content.employment?.find(job => job.id === entry.employmentId) ?? null;
  // Archived evidence is shown nowhere and built from nothing, so it is not worth a model call:
  // a block archived with the job it belonged to would otherwise be classified for ever, and the
  // content read here has not been parsed, so archived is the one status that stands a block
  // aside (a block an earlier release stored as a draft is evidence, and is reviewed).
  const entries = library.content.entries.filter(entry =>
    REVIEWABLE_KINDS.has(entry.kind) && isActiveStoredEvidence(entry) && reviewableRows(entry).length > 0);
  if (!entries.length) return { reviewed: 0, reused: 0, ...newer, skipped: "no reviewable entries" };
  const hashes = new Map(entries.map(entry => [entry.id, libraryEntryInputHash(entry, employmentOf(entry))]));

  const write = async (reviews: LibraryReviewUpsert[]) => {
    if (!reviews.length) return;
    await deps.db.transaction(async tx => {
      await deps.assertOwnership?.(tx as unknown as Db);
      await upsertLibraryReviews(tx as unknown as Db, userId, version, reviews, deps.now());
    });
  };

  // What each entry already carries, read before anything is written: an entry holding a model
  // review of this exact wording is done, whatever library version that review was written under.
  const stored = await latestLibraryReviews(deps.db, userId,
    entries.map(entry => ({ entryId: entry.id, inputHash: hashes.get(entry.id)! })));

  // The baseline, before a model is asked anything, so the Library has a score for every entry the
  // moment the task starts. The one exception is an entry whose model review is already stored
  // against this same version: one row per (account, version, entry) means writing the baseline
  // over it would throw that answer away, which is what a re-run of an unchanged library is.
  await write(entries.flatMap(entry => {
    const held = stored.get(entry.id);
    if (held?.source === "model" && held.libraryVersion === version) return [];
    return [{
      entryId: entry.id,
      inputHash: hashes.get(entry.id)!,
      review: rulesLibraryReview(entry, library.content),
      source: "rules" as const,
    }];
  }));

  const pending = entries.filter(entry => stored.get(entry.id)?.source !== "model");
  const reused = entries.length - pending.length;
  if (!pending.length) return { reviewed: 0, reused, ...newer, cost: 0 };

  const settings = await deps.userSettings(userId);
  // The model the account chose for its own CV work: a library review is the same judgement about
  // the same evidence, made earlier and far more cheaply.
  const model = settings.cvModel;
  let cost = 0;
  const ai = createAiEngine({
    apiKey: deps.env.anthropicApiKey,
    client: deps.aiClient,
    getModel: () => model,
    // The pass stops when the task does: a deadline or a reclaimed task cuts off the calls in
    // flight instead of paying for answers nobody will read.
    ...(ctx?.signal ? { signal: ctx.signal } : {}),
    onUsage: async usage => {
      cost += usage.costUsd;
      await recordAiCall(deps.db, userId, usage);
    },
    logger: (msg, data) => log.debug(`ai ${msg}`, data),
  });
  // Asked of the engine this pass will actually use, rather than of the shared one: a deployment
  // with no key still gets its rules baseline, written above, and finishes done.
  if (!ai.enabled) return { reviewed: 0, reused, ...newer, skipped: "ai unavailable", cost: 0 };
  const expected = estimateLibraryReviewUsd(model, {
    libraryBytes: Buffer.byteLength(JSON.stringify(library.content)),
    entryCount: pending.length,
  });
  const admitted = await tryReserveAi(deps.db, "A12", expected, {
    account: {
      userId,
      budgetUsd: settings.aiBudgetUsd,
      since: aiBudgetWindowStart(deps.now(), settings.aiBudgetResetAt),
    },
    daily: deps.env.dailyAiBudgetUsd ?? 1000000,
    discovery: deps.env.discoveryAiBudgetUsd ?? 1000000,
    workerId: deps.env.workerId,
    refId: `library:${userId}:${version}`,
  }, deps.now(), HOLD_MINUTES);
  if ("refused" in admitted) {
    // Finished, never failed: the rules baseline is already on the page, and retrying a pass the
    // month cannot afford would only fill Health with work nothing can complete.
    log.info("library review refused by budget", { userId, version, entries: pending.length, expected });
    return {
      reviewed: 0,
      reused,
      ...newer,
      skipped: "budget",
      message: aiBudgetRefusalMessage(aiFeatureLabel("A12"), expected, admitted.refused),
      cost: 0,
    };
  }

  try {
    const reviews = await ai.reviewLibraryEntries(
      { library: library.content, entries: pending, model },
      { userId, refType: "library", refId: `library:${userId}:${version}` },
    );
    const byEntry = new Map(reviews.map(review => [review.entryId, review]));
    await write(pending.flatMap(entry => {
      const review = byEntry.get(entry.id);
      return review ? [{ entryId: entry.id, inputHash: hashes.get(entry.id)!, review, source: "model" as const, model }] : [];
    }));
    const pruned = await pruneLibraryReviews(deps.db, userId);
    log.info("library reviewed", { userId, version, reviewed: byEntry.size, reused, pruned, usd: usd(cost) });
    return { reviewed: byEntry.size, reused, ...newer, cost: usd(cost) };
  } finally {
    // The calls' real costs are in `ai_calls`; the hold only covered the gap until they landed.
    await admitted.release();
  }
}
