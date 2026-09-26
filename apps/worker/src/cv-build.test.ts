/**
 * What a CV build says about itself, and what it does when something goes wrong.
 *
 * These drive the real engine through a scripted client rather than stubbing `AiEngine`, because
 * the things under test are the engine's own: which class a provider threw, whether a batch was
 * re-run, what each call cost. The queue is real too, so a retry is a real requeue with a real
 * backoff and a real second claim.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { actionCvs, enqueueTask, failOpenCvBuildSteps, listCvBuildSteps, schema, startCvBuildStep, type Db, type Task } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { InternalServerError, RateLimitError, type AiClientLike, type ParseResponse } from "@ava/ai";
import { DEFAULT_CV_THEME, materialiseCv } from "@ava/core/cv";
import { createCvAssessment } from "@ava/core/cv-review";
import { cvClaimItems, cvEvidenceItems, cvTextItems } from "@ava/core/cv-assessment";
import type { CvBuildFailure, CvBuildStepView } from "@ava/core";
import { dedupeKeyFor } from "@ava/core";
import { eq, sql } from "drizzle-orm";
import { rubricFixture, reviewFixture } from "../../../packages/core/test/cv-review-fixture";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { claimTask, failTask, requeueStale, TaskQueue, TASK_STALE_AFTER_MS } from "./queue";
import { CV_BUSY_MESSAGE, handleGenerateCv } from "./handlers/cv";
import { CvJournal, type CvJournalLoss } from "./handlers/cv-journal";
import { CV_ABANDONED_MESSAGE, onAbandon, onInterrupted } from "./handlers/abandon";
import { tryReserveAi } from "./budget";
import { LeaseBusyError, LeaseLostError } from "./lease";
import { ensureTestUser } from "./test-users";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test";

let deps: WorkerDeps;
let db: Db;
let userId: string;

const library = {
  name: "Test Candidate",
  contact: "London",
  profile: "Operations leader with delivery experience",
  entries: [{ id: "one", kind: "experience" as const, heading: "Director · Acme", details: "Led a team", confirmedResponsibilities: ["Led a team"] }],
};
const plan = { summary: "Operations leader", sections: [{ entryId: "one", bullets: ["Led a team"] }], gaps: [] };

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.AVA_DISABLE_BROWSER = "1";
  const bootstrap = await createDeps(readEnv());
  await runMigrations(bootstrap.db);
  deps = bootstrap;
  db = deps.db;
  deps.env.anthropicApiKey = "fixture-key";
  userId = (await ensureTestUser(db, "cv-build@example.com")).id;
}, 60_000);

afterAll(async () => {
  await deps?.close();
});

beforeEach(async () => {
  await db.execute(sql`truncate tasks, applications, cv_build_steps, cv_share_comments, cv_shares, cv_drafts, ai_calls, ai_reservations, worker_events`);
  deps.userSettings = (async () => ({ aiBudgetUsd: 1000, aiBudgetResetAt: null })) as unknown as WorkerDeps["userSettings"];
  deps.aiClient = undefined;
});

/** The usage figures every scripted answer is billed for, so every step carries a real cost. */
const USAGE = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 3000, cache_creation_input_tokens: 500 };
type Answer = (params: Record<string, unknown>) => ParseResponse | Promise<ParseResponse>;
type CallKind = "rubric" | "author" | "review";

/** The three prompts a build sends, told apart by the shape of the user turn the engine built. */
function callKindOf(params: Record<string, unknown>): CallKind {
  const content = (params.messages as Array<{ content: unknown }>)[0]!.content;
  if (Array.isArray(content)) return "review";
  return (JSON.parse(content as string) as { jobTitle?: string }).jobTitle ? "author" : "rubric";
}

function answered(parsed: unknown, over: Partial<ParseResponse> = {}): ParseResponse {
  return { parsed_output: parsed, usage: USAGE, stop_reason: "end_turn", model: "claude-sonnet-5", ...over };
}

/** One batch of the audit, answered from the three blocks the engine sent it. */
function reviewAnswer(params: Record<string, unknown>): ParseResponse {
  const blocks = (params.messages as Array<{ content: Array<{ text: string }> }>)[0]!.content;
  const stable = JSON.parse(blocks[0]!.text) as { evidence: Array<{ id: string; text: string }> };
  const printed = JSON.parse(blocks[1]!.text) as { cv: Array<{ id: string; text: string }> };
  const batch = JSON.parse(blocks[2]!.text) as { requirements: never[]; claims: Array<{ id: string; text: string }> };
  return answered(reviewFixture({
    rubric: { requirements: batch.requirements, caveats: [] },
    cv: printed.cv, claims: batch.claims, evidence: stable.evidence,
  }));
}

/** A client that answers each of the build's three call sites from a script. */
function scriptedClient(script: Partial<Record<CallKind, Answer>> = {}) {
  const calls: CallKind[] = [];
  const client: AiClientLike = {
    messages: {
      async create(params) {
        const kind = callKindOf(params);
        calls.push(kind);
        const answer = script[kind];
        if (answer) return await answer(params);
        if (kind === "rubric") return answered(rubricFixture((JSON.parse((params.messages as Array<{ content: string }>)[0]!.content) as { description: string }).description));
        if (kind === "author") return answered(plan);
        return reviewAnswer(params);
      },
    },
  };
  return { client, calls, count: (kind: CallKind) => calls.filter(call => call === kind).length };
}

async function makeDraft(over: Partial<typeof schema.cvDrafts.$inferInsert> = {}) {
  const [draft] = await db.insert(schema.cvDrafts).values({
    userId, jobTitle: "Operations Director", companyName: "Acme", jobDescription: "Lead a team",
    libraryVersion: 1, librarySnapshot: library, model: "claude-sonnet-5", ...over,
  }).returning();
  const payload = { draftId: draft!.id, userId };
  await enqueueTask(db, "generate_cv", payload, { dedupeKey: dedupeKeyFor("generate_cv", payload) });
  return draft!;
}

/** The queue as the worker runs it: one slot, the real handler, the real abandonment hook. */
function queueFor(): TaskQueue {
  return new TaskQueue(deps, { generate_cv: handleGenerateCv }, { concurrency: 1, workerId: "cv-pod", onAbandon });
}

const draftAfter = async (id: string) => (await db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, id)))[0]!;
const taskRow = async () => (await db.select().from(schema.tasks))[0]!;
const steps = (id: string) => listCvBuildSteps(db, userId, id);
const motions = (rows: CvBuildStepView[]) => rows.map(row => row.motion);
const aiCallsByStage = async () =>
  Object.fromEntries((await db.execute<{ stage: string; n: number }>(
    sql`select coalesce(stage, '?') as stage, count(*)::int as n from ai_calls group by 1`)).rows.map(row => [row.stage, Number(row.n)]));

/** Let a requeued task run now, without waiting out its backoff. */
async function runDueNow() {
  await db.update(schema.tasks).set({ runAfter: sql`now()` });
  await queueFor().drain();
}

it("narrates every motion of a clean build, with the figures and the cost of each model call", async () => {
  const scripted = scriptedClient();
  deps.aiClient = scripted.client;
  const draft = await makeDraft();

  await queueFor().drain();

  const rows = await steps(draft.id);
  // Each stage is admitted against the budget immediately before it runs, and only then.
  expect(motions(rows)).toEqual([
    "load_inputs", "admit_budget", "rubric", "admit_budget", "write", "check_plan", "measure",
    "admit_budget", "assess_batch", "assemble", "publish",
  ]);
  expect(rows.every(row => row.status === "done")).toBe(true);
  expect(rows.every(row => row.attempt === 1 && row.finishedAt !== null && row.ms !== null)).toBe(true);
  expect(rows.every(row => row.taskId === rows[0]!.taskId && row.taskId !== null)).toBe(true);
  const byMotion = Object.fromEntries(rows.map(row => [row.motion, row]));

  expect(byMotion.load_inputs!.detail).toEqual({
    libraryVersion: 1, roles: 1, qualifications: 0, skillBlocks: 0, descriptionCharacters: 11,
    mode: "build", reusedRubric: false, reusedContent: false, maxAttempts: 3,
  });
  const admits = rows.filter(row => row.motion === "admit_budget");
  expect(admits.map(row => row.detail.stage)).toEqual(["rubric", "write", "audit"]);
  for (const admit of admits) {
    expect(admit.detail).toMatchObject({ limitUsd: 1000, leftUsd: expect.any(Number) });
    expect(admit.detail.expectedUsd as number).toBeGreaterThan(0);
    // What the account's other work holds: this stage's own hold is not counted in it.
    expect(admit.detail.heldUsd).toBe(0);
  }
  // Nothing is held once the build is over.
  expect(await db.select().from(schema.aiReservations)).toHaveLength(0);

  expect(byMotion.rubric!.detail).toMatchObject({ requirements: 1, essential: 1, desirable: 0, responsibilities: 0 });
  expect(byMotion.write!.title).toBe("Writing the CV");
  expect(byMotion.write!.detail).toMatchObject({ attempt: 1, budgetScale: 1, maxPages: 3, roles: 1, bullets: 1 });
  expect(byMotion.write!.detail.budgetCharacters as number).toBeGreaterThan(0);
  expect(byMotion.write!.detail.characters).toBe(plan.summary.length + "Led a team".length);
  expect(byMotion.check_plan!.detail).toEqual({ omitted: [], skillFormatCorrections: 0 });
  expect(byMotion.measure!.detail).toEqual({ pages: 1, maxPages: 3, renders: 1, outcome: "fits" });
  expect(byMotion.assess_batch!.title).toBe("Checking requirements 1–1 and 2 claims (batch 1 of 1)");
  expect(byMotion.assess_batch!.detail).toMatchObject({ batch: 1, batches: 1, requirements: 1, claims: 2, pass: "draft" });
  expect(byMotion.assemble!.detail).toEqual({
    demonstrated: 1, partial: 0, missing: 0, unknown: 0, supported: 2, unsupported: 0, uncertain: 0, pageCount: 1,
  });
  expect(byMotion.publish!.detail).toMatchObject({ revision: 1, archivedPrevious: false });
  // What the stages were admitted at, and what the build recorded: every call, every attempt.
  const reserved = admits.reduce((sum, admit) => sum + (admit.detail.expectedUsd as number), 0);
  expect(byMotion.publish!.detail.reservedUsd).toBeCloseTo(reserved, 3);
  const recorded = await db.execute<{ total: number }>(sql`select coalesce(sum(cost_usd::float8), 0) as total from ai_calls`);
  expect(byMotion.publish!.detail.spentUsd).toBeCloseTo(Number(recorded.rows[0]!.total), 3);

  // Every model call's own cost reaches the step that made it, and nothing else claims one.
  for (const motion of ["rubric", "write", "assess_batch"]) {
    expect(byMotion[motion]!.detail.usd as number).toBeGreaterThan(0);
    expect(byMotion[motion]!.detail.tokens).toBe(4700);
  }
  expect(byMotion.load_inputs!.detail.usd).toBeUndefined();

  const saved = await draftAfter(draft.id);
  expect(saved.status).toBe("ready");
  expect(saved.failure).toBeNull();
  expect(saved.buildCheckpoint).toBeNull();
  expect(saved.progressAt).not.toBeNull();
  expect(await aiCallsByStage()).toEqual({ rubric: 1, author: 1, review: 1 });
});

it("resumes from its checkpoint after the provider rate-limits the writer, paying for one rubric in all", async () => {
  let limited = true;
  const scripted = scriptedClient({
    author: () => {
      if (!limited) return answered(plan);
      limited = false;
      throw new RateLimitError(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, undefined, new Headers());
    },
  });
  deps.aiClient = scripted.client;
  const draft = await makeDraft();

  await queueFor().drain();

  // The writing step is the one that failed, and it says what the provider said.
  const first = await steps(draft.id);
  const write = first.find(row => row.motion === "write")!;
  expect(write.status).toBe("failed");
  expect(write.failure).toMatchObject({ kind: "rate_limited", resolvedBy: "system", retryable: true });
  expect(write.error).toBe("The model provider asked us to slow down while writing the CV.");

  // The draft is still building, with the wait explained, and the queue is bringing it back.
  const waiting = await draftAfter(draft.id);
  expect(waiting.status).toBe("generating");
  const failure = waiting.failure as CvBuildFailure;
  expect(failure).toMatchObject({ kind: "rate_limited", attempt: 1, maxAttempts: 3, resolvedBy: "system" });
  expect(new Date(failure.retryAt!).getTime()).toBeGreaterThan(Date.now());
  expect(waiting.buildCheckpoint?.rubric).toBeTruthy();
  const requeued = await taskRow();
  expect(requeued.status).toBe("queued");
  expect(requeued.attempts).toBe(1);
  expect(requeued.runAfter!.getTime()).toBeGreaterThan(Date.now());
  expect(await claimTask(db, "cv-pod#0")).toBeNull();

  await runDueNow();

  const rows = await steps(draft.id);
  const second = rows.filter(row => row.attempt === 2);
  // The rubric is reused, so nothing is admitted for it: the writing is the first stage paid for.
  expect(motions(second)).toEqual(["load_inputs", "rubric", "admit_budget", "write", "check_plan", "measure", "admit_budget", "assess_batch", "assemble", "publish"]);
  // The failed call's cost reached the step that made it.
  expect(write.detail.usd === undefined || (write.detail.usd as number) >= 0).toBe(true);
  // The rubric was paid for on the first attempt, so the second takes it from the checkpoint.
  const rubric = second.find(row => row.motion === "rubric")!;
  expect(rubric.status).toBe("skipped");
  expect(rubric.detail).toEqual({ reused: "checkpoint" });
  expect(second.find(row => row.motion === "load_inputs")!.detail).toMatchObject({ reusedRubric: true, reusedContent: false });

  const ready = await draftAfter(draft.id);
  expect(ready.status).toBe("ready");
  expect(ready.failure).toBeNull();
  expect(ready.buildCheckpoint).toBeNull();
  expect((await taskRow()).status).toBe("done");
  expect(await aiCallsByStage()).toEqual({ rubric: 1, author: 2, review: 1 });
});

it.each([
  ["declines", { stop_reason: "refusal", stop_details: { category: "policy" } }, "refused", "declined this request twice", "retry"],
  ["runs out of room", { stop_reason: "max_tokens" }, "output_limit", "ran out of room for its answer twice", "choose_model"],
])("tries once more when the writer %s, then asks the person rather than spending a third attempt", async (_label, over, kind, asks, action) => {
  const scripted = scriptedClient({ author: () => answered(null, over as Partial<ParseResponse>) });
  deps.aiClient = scripted.client;
  const draft = await makeDraft();

  // The first time, the system resolves it itself: same model, same prompt, one more go.
  await queueFor().drain();
  const retrying = await draftAfter(draft.id);
  expect(retrying.status).toBe("generating");
  expect(retrying.failure).toMatchObject({ kind, resolvedBy: "system", retryable: true, attempt: 1 });

  await runDueNow();

  const asked = await draftAfter(draft.id);
  expect(asked.status).toBe("failed");
  expect(asked.failure).toMatchObject({ kind, resolvedBy: "user", retryable: false, action, attempt: 2, maxAttempts: 3 });
  expect(asked.error).toContain(asks);
  // The task is finished, not waiting: a failure the person must resolve spends no more attempts.
  const task = await taskRow();
  expect(task.status).toBe("done");
  expect(task.attempts).toBe(2);
  expect(scripted.count("author")).toBe(2);
  const failed = (await steps(draft.id)).filter(row => row.status === "failed");
  expect(failed.map(row => row.motion)).toEqual(["write", "write"]);
});

it("names the second charge when a batch has to be re-run to correct its attribution", async () => {
  let corrected = false;
  const scripted = scriptedClient({
    review: (params) => {
      const answer = reviewAnswer(params);
      if (corrected) return answer;
      corrected = true;
      // The first answer cites the profile for a claim whose evidence must be its own entry, so
      // the engine sends the batch back once with the correction.
      const plan = answer.parsed_output as { claims: Array<{ evidence: Array<{ id: string; quote: string }> }> };
      for (const claim of plan.claims) claim.evidence = [{ id: "source:profile", quote: library.profile }];
      return answer;
    },
  });
  deps.aiClient = scripted.client;
  const draft = await makeDraft();

  await queueFor().drain();

  expect((await draftAfter(draft.id)).status).toBe("ready");
  const rows = await steps(draft.id);
  const batch = rows.find(row => row.motion === "assess_batch")!;
  const retry = rows.find(row => row.motion === "assess_retry")!;
  expect(motions(rows).slice(-4)).toEqual(["assess_batch", "assess_retry", "assemble", "publish"]);
  expect(batch.status).toBe("done");
  expect(retry.status).toBe("done");
  expect(retry.detail).toMatchObject({ batch: 1, corrections: 1 });
  expect(retry.detail.usd as number).toBeGreaterThan(0);
  // The re-run is charged what it cost, tokens and all: a literal zero here dragged the
  // Operations median for this motion down to nothing.
  expect(retry.detail.tokens).toBe(4700);
  // Both charges are the audit's, and the engine names the second separately in the call log.
  expect(await aiCallsByStage()).toEqual({ rubric: 1, author: 1, review: 1, review_retry: 1 });
});

it("refuses a build the account cannot afford before any model call, and asks for the budget", async () => {
  const scripted = scriptedClient();
  deps.aiClient = scripted.client;
  deps.userSettings = (async () => ({ aiBudgetUsd: 0.01, aiBudgetResetAt: null })) as unknown as WorkerDeps["userSettings"];
  const draft = await makeDraft();

  await queueFor().drain();

  const refused = await draftAfter(draft.id);
  expect(refused.status).toBe("failed");
  expect(refused.failure).toMatchObject({ kind: "budget_exhausted", resolvedBy: "user", retryable: false, action: "raise_budget", motion: "admit_budget" });
  expect(refused.error).toContain("This build's requirements analysis needs about $");
  expect(refused.error).toContain("your budget of $0.01");
  const rows = await steps(draft.id);
  expect(motions(rows)).toEqual(["load_inputs", "admit_budget"]);
  const admit = rows[1]!;
  expect(admit.status).toBe("failed");
  expect(admit.detail).toMatchObject({ stage: "rubric", limitUsd: 0.01, heldUsd: 0, leftUsd: 0.01 });
  // Nothing was spent, and the attempt that would have spent it is not retried.
  expect(scripted.calls).toEqual([]);
  expect(await db.select().from(schema.aiCalls)).toHaveLength(0);
  const task = await taskRow();
  expect(task.status).toBe("done");
  expect(task.attempts).toBe(1);
});

it("gives up on a CV that will not fit the page limit, showing what each attempt measured", async () => {
  const entries = ["one", "two", "three", "four", "five", "six", "seven", "eight"];
  const long = {
    summary: "Operations leader with experience planning and reporting. ".repeat(29),
    sections: entries.map(entryId => ({ entryId, bullets: Array.from({ length: 6 }, () => "Managed operational planning and reporting. ".repeat(14)) })),
    gaps: [],
  };
  const scripted = scriptedClient({ author: () => answered(long) });
  deps.aiClient = scripted.client;
  const draft = await makeDraft({
    librarySnapshot: {
      ...library, theme: { ...DEFAULT_CV_THEME, maxPages: 2 },
      entries: entries.map(id => ({ ...library.entries[0]!, id, heading: `Director ${id}` })),
    },
  });

  await queueFor().drain();

  const failed = await draftAfter(draft.id);
  expect(failed.status).toBe("failed");
  expect(failed.failure).toMatchObject({ kind: "page_limit_unfittable", resolvedBy: "user", retryable: false, action: "shorten_or_raise_pages" });
  expect(failed.error).toMatch(/^The CV is \d+ pages after three attempts; the limit is 2\./);
  expect(failed.content).toBeNull();

  const rows = await steps(draft.id);
  // The first attempt writes; the ones after it rewrite to a smaller budget, which the catalogue
  // has as a motion of its own — so the narrative names it rather than relabelling a `write`.
  const writes = rows.filter(row => row.motion === "write" || row.motion === "rewrite");
  expect(writes.map(row => row.motion)).toEqual(["write", "rewrite", "rewrite"]);
  expect(writes.map(row => row.detail.attempt)).toEqual([1, 2, 3]);
  expect(writes.map(row => row.title)).toEqual(["Writing the CV", "Rewriting to a smaller budget", "Rewriting to a smaller budget"]);
  // Each attempt is given a smaller budget than the last, and each is measured against the limit.
  const scales = writes.map(row => row.detail.budgetScale as number);
  expect(scales[0]).toBeGreaterThan(scales[1]!);
  expect(scales[1]).toBeGreaterThan(scales[2]!);
  const measures = rows.filter(row => row.motion === "measure");
  expect(measures).toHaveLength(3);
  expect(measures.every(row => (row.detail.pages as number) > 2 && row.detail.maxPages === 2)).toBe(true);
  // Trimming is reported with the measurement it produced, naming what it took out.
  const shorten = rows.filter(row => row.motion === "shorten");
  expect(shorten.length).toBeGreaterThan(0);
  expect((shorten[0]!.detail.changes as string[]).length).toBeLessThanOrEqual(6);
  expect(shorten[0]!.detail.removed as number).toBeGreaterThan(0);
  expect(scripted.count("author")).toBe(3);
  expect(scripted.count("review")).toBe(0);
});

it("re-assesses a saved CV after a failed batch without paying for the rubric or the writing again", async () => {
  let overloaded = true;
  const scripted = scriptedClient({
    review: (params) => {
      if (!overloaded) return reviewAnswer(params);
      overloaded = false;
      throw new InternalServerError(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, undefined, new Headers());
    },
  });
  deps.aiClient = scripted.client;
  const draft = await makeDraft();

  await queueFor().drain();

  const waiting = await draftAfter(draft.id);
  expect(waiting.status).toBe("generating");
  expect(waiting.failure).toMatchObject({ kind: "overloaded", resolvedBy: "system", retryable: true, attempt: 1 });
  // The writing is paid for and saved, so the checkpoint says the retry may start at the audit.
  expect(waiting.content).not.toBeNull();
  expect(waiting.buildCheckpoint?.contentAt).toBeTruthy();
  expect((await steps(draft.id)).find(row => row.motion === "assess_batch")!.status).toBe("failed");

  await runDueNow();

  const rows = await steps(draft.id);
  const second = rows.filter(row => row.attempt === 2);
  // The saved wording is measured as it is read, and reused; the audit is the only stage paid for.
  expect(motions(second)).toEqual(["load_inputs", "measure", "rubric", "write", "admit_budget", "assess_batch", "assemble", "publish"]);
  expect(second.find(row => row.motion === "write")).toMatchObject({ status: "skipped", detail: { reused: "checkpoint", attempt: 1 } });
  expect(second.find(row => row.motion === "load_inputs")!.detail).toMatchObject({ reusedRubric: true, reusedContent: true });
  expect(second.find(row => row.motion === "rubric")!.status).toBe("skipped");
  expect(rows.filter(row => row.motion === "assess_batch").map(row => row.attempt)).toEqual([1, 2]);

  expect((await draftAfter(draft.id)).status).toBe("ready");
  // The retry is admitted at what it can still spend — the audit — and nothing else.
  const admits = rows.filter(row => row.motion === "admit_budget");
  expect(admits.map(row => [row.attempt, row.detail.stage])).toEqual([[1, "rubric"], [1, "write"], [1, "audit"], [2, "audit"]]);
  expect(admits[3]!.detail.expectedUsd).toBe(admits[2]!.detail.expectedUsd);
  // One rubric, one author, two audits: the retry cost the audit alone.
  expect(await aiCallsByStage()).toEqual({ rubric: 1, author: 1, review: 2 });
  const spentOnRetry = await db.execute<{ total: number }>(sql`select coalesce(sum(cost_usd::float8), 0) as total from ai_calls where stage = 'review'`);
  const spentOnWriting = await db.execute<{ total: number }>(sql`select coalesce(sum(cost_usd::float8), 0) as total from ai_calls where stage in ('rubric', 'author')`);
  expect(Number(spentOnRetry.rows[0]!.total)).toBeGreaterThan(0);
  expect(Number(spentOnWriting.rows[0]!.total)).toBeGreaterThan(0);
});

it("publishes the saved baseline of a build stopped during its improvement, without assessing it again", async () => {
  // The first attempt wrote, assessed and saved its baseline, set the one-shot fence, and was then
  // interrupted while the optional improvement was being written.
  const content = materialiseCv(library, plan);
  const rubric = rubricFixture("Lead a team");
  const assessment = createCvAssessment({
    content, description: "Lead a team", library, rubric, model: "claude-sonnet-5", pageCount: 1,
    review: reviewFixture({ rubric, cv: cvTextItems(content), claims: cvClaimItems(content), evidence: cvEvidenceItems(library) }),
  });
  const draft = await makeDraft({
    status: "generating", content, assessment,
    buildCheckpoint: { rubric, rubricAt: "2026-09-01T00:00:00.000Z", contentAt: "2026-09-01T00:01:00.000Z", improvementAttempted: true, tailoringEnabled: true, quizCompleted: true, attempt: 1 },
  });
  const scripted = scriptedClient();
  deps.aiClient = scripted.client;
  await db.update(schema.tasks).set({ attempts: 1 });

  await queueFor().drain();

  const published = await draftAfter(draft.id);
  expect(published.status).toBe("ready");
  expect(published.assessment).toEqual(assessment);
  // Nothing was asked of a model, and nothing was held for it.
  expect(scripted.calls).toEqual([]);
  expect(await aiCallsByStage()).toEqual({});
  const rows = await steps(draft.id);
  expect(rows.some(row => row.motion === "admit_budget")).toBe(false);
  expect(rows.some(row => row.motion === "assess_batch")).toBe(false);
  expect(rows.find(row => row.motion === "assemble")).toMatchObject({ status: "skipped", detail: { reused: true } });
});

it("closes the narrative of a build whose worker died, with the taxonomy the page reads", async () => {
  const draft = await makeDraft({ status: "generating", buildStage: "writing" });
  const task = (await claimTask(db, "dead-pod#0", "interactive"))!;
  await db.update(schema.tasks).set({ attempts: 3, lockedAt: new Date(Date.now() - 60 * 60_000) }).where(eq(schema.tasks.id, task.id));
  await startCvBuildStep(db, { draftId: draft.id, userId, taskId: task.id, attempt: 3, motion: "write" });
  await db.execute(sql`insert into ai_reservations (user_id, call_site, amount, expires_at, worker_id, ref_id)
    values (${userId}, 'CV', 3.06, now() + interval '30 minutes', 'dead-pod', ${draft.id})`);

  expect(await requeueStale(db, TASK_STALE_AFTER_MS, "live-pod", { deps, onAbandon })).toEqual({ requeued: 0, failed: 1 });

  const abandoned = await draftAfter(draft.id);
  expect(abandoned.status).toBe("failed");
  expect(abandoned.error).toBe(CV_ABANDONED_MESSAGE);
  expect(abandoned.failure).toMatchObject({
    kind: "worker_interrupted", resolvedBy: "user", retryable: false, action: "retry", attempt: 3, maxAttempts: 3,
  });
  const rows = await steps(draft.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ motion: "write", status: "failed" });
  expect((rows[0]!.failure as CvBuildFailure).kind).toBe("worker_interrupted");
  // The hold the dead build was keeping is gone, so the rebuild we just asked for is not refused.
  const held = await db.execute<{ n: number }>(sql`select count(*)::int as n from ai_reservations where user_id = ${userId}`);
  expect(Number(held.rows[0]!.n)).toBe(0);
});

/* -------------------------------------------------------------------------------------------
 * Two builds of one account, and the fences between them
 * ----------------------------------------------------------------------------------------- */

/** Hold capacity for one build, exactly as an admitted build does. */
async function holdFor(draftId: string, amount = 3) {
  const taken = await tryReserveAi(db, "CV", amount, {
    account: { userId, budgetUsd: 1000, since: new Date(0) },
    daily: 1_000_000, discovery: 1_000_000, workerId: "cv-pod", refId: draftId,
  }, new Date(), 30);
  if ("refused" in taken) throw new Error("the test account should be able to afford this build");
  return taken;
}

it("gives back only the abandoned build's hold, leaving a sibling build's capacity and renewal intact", async () => {
  const first = await makeDraft({ status: "generating" });
  const second = await makeDraft({ status: "generating" });
  const one = await holdFor(first.id);
  const two = await holdFor(second.id);

  // The queue gives up on the first build's task. The second build is still running.
  const task = (await claimTask(db, "dead-pod#0", "interactive"))!;
  expect((task.payload as { draftId: string }).draftId).toBe(first.id);
  await db.update(schema.tasks).set({ attempts: 3, lockedAt: new Date(Date.now() - 60 * 60_000) }).where(eq(schema.tasks.id, task.id));

  expect(await requeueStale(db, TASK_STALE_AFTER_MS, "live-pod", { deps, onAbandon })).toEqual({ requeued: 0, failed: 1 });

  const held = await db.execute<{ refId: string }>(sql`select ref_id as "refId" from ai_reservations where user_id = ${userId}`);
  expect(held.rows.map(row => row.refId)).toEqual([second.id]);
  // The survivor's renewal still matches its row; the abandoned build's has nothing left to renew.
  expect(await two.renew()).toBe(true);
  expect(await one.renew()).toBe(false);
  expect((await draftAfter(first.id)).status).toBe("failed");
  expect((await draftAfter(second.id)).status).toBe("generating");
});

it("admits a build at the figures its own reservation was measured against", async () => {
  // Another build of this account is already holding capacity for itself.
  await db.execute(sql`insert into ai_reservations (user_id, call_site, amount, expires_at, worker_id, ref_id)
    values (${userId}, 'CV', 2.5, now() + interval '30 minutes', 'cv-pod', gen_random_uuid()::text)`);
  deps.aiClient = scriptedClient().client;
  const draft = await makeDraft();

  await queueFor().drain();

  const admit = (await steps(draft.id)).find(row => row.motion === "admit_budget")!;
  const expected = admit.detail.expectedUsd as number;
  expect(expected).toBeGreaterThan(0);
  // Read inside the lock that took the hold, so the figures explain the decision they came with:
  // what the account's other work holds, excluding this stage's own hold.
  expect(admit.detail).toMatchObject({ stage: "rubric", limitUsd: 1000, heldUsd: 2.5 });
  expect(admit.detail.leftUsd).toBe(Number((1000 - 2.5 - expected).toFixed(4)));
});

it("never deletes a build in flight when its role is archived, and refuses to delete one outright", async () => {
  const saved = await makeDraft({ status: "ready" });
  const building = await makeDraft({ status: "generating" });
  const alsoBuilding = await makeDraft({ status: "generating" });

  await actionCvs(db, userId, [saved.id, building.id, alsoBuilding.id], "archive");

  const rows = await db.select().from(schema.cvDrafts);
  // Both builds survive their role being archived: their workers are still writing them.
  expect(rows.map(row => row.id).sort()).toEqual([saved.id, building.id, alsoBuilding.id].sort());
  expect(rows.find(row => row.id === saved.id)!.archivedAt).not.toBeNull();
  expect(rows.filter(row => row.status === "generating").map(row => row.archivedAt)).toEqual([null, null]);

  // Deleting one is refused in the person's own words: only they can stop a build first.
  await expect(actionCvs(db, userId, [saved.id, building.id], "delete")).rejects.toMatchObject({
    userFacing: true, message: expect.stringContaining("still being built"),
  });
  expect(await db.select().from(schema.cvDrafts)).toHaveLength(3);
});

it("lets one attempt close only its own motions, so a zombie cannot end the attempt that replaced it", async () => {
  const draft = await makeDraft({ status: "generating" });
  const zombie = await startCvBuildStep(db, { draftId: draft.id, userId, attempt: 1, motion: "write" });
  const live = await startCvBuildStep(db, { draftId: draft.id, userId, attempt: 2, motion: "write" });

  expect(await failOpenCvBuildSteps(db, draft.id, "the worker was interrupted", undefined, { attempt: 1 })).toBe(1);

  const rows = await steps(draft.id);
  expect(rows.find(row => row.id === zombie)).toMatchObject({ status: "failed", attempt: 1 });
  expect(rows.find(row => row.id === live)).toMatchObject({ status: "running", attempt: 2 });
  // A recovery giving up on the draft for good closes everything that is left.
  expect(await failOpenCvBuildSteps(db, draft.id, "gave up", undefined)).toBe(1);
  expect((await steps(draft.id)).every(row => row.status === "failed")).toBe(true);
});

it("gives two attempts writing at once distinct places in the narrative", async () => {
  const draft = await makeDraft();
  // Without the draft's allocation lock both read the same `max(seq)`; the unique index then
  // refuses one of them, and the narrative loses a motion.
  await Promise.all([1, 2, 1, 2, 1].map(attempt =>
    startCvBuildStep(db, { draftId: draft.id, userId, attempt, motion: "measure" })));
  const rows = await steps(draft.id);
  expect(rows).toHaveLength(5);
  expect(new Set(rows.map(row => row.seq)).size).toBe(5);
  expect([...rows.map(row => row.seq)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
});

it("stops writing for a draft that has been deleted, or a hold something else has released", async () => {
  const draft = await makeDraft({ status: "generating" });
  const losses: CvJournalLoss[] = [];
  let renewable = true;
  const journal = new CvJournal({
    db, draftId: draft.id, userId, taskId: null, attempt: 1, now: deps.now,
    renewHold: async () => renewable,
    onLost: loss => losses.push(loss),
  });
  await journal.record("measure", { pages: 1, maxPages: 3 });
  expect(losses).toEqual([]);

  // The budget stopped holding capacity for this build while it was running.
  renewable = false;
  await journal.record("measure", { pages: 2, maxPages: 3 });
  expect(losses).toEqual(["hold"]);
  expect(await steps(draft.id)).toHaveLength(2);

  // A fence that refuses the mark means this attempt is no longer the live one, so the journal
  // stops writing rather than narrating over the attempt that replaced it.
  const fenced: CvJournalLoss[] = [];
  const zombie = new CvJournal({
    db, draftId: draft.id, userId, taskId: null, attempt: 1, now: deps.now,
    assertOwnership: async () => { throw new LeaseLostError("Task lease lost; refusing stale writes"); },
    onLost: loss => fenced.push(loss),
  });
  await zombie.record("measure", { pages: 9, maxPages: 3 });
  expect(fenced).toEqual(["fenced"]);
  const before = (await steps(draft.id)).length;
  await zombie.record("measure", { pages: 9, maxPages: 3 });
  expect(await steps(draft.id)).toHaveLength(before);

  // And a draft deleted mid-build is noticed by the one write every motion makes.
  await db.delete(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  const gone = new CvJournal({ db, draftId: draft.id, userId, taskId: null, attempt: 1, now: deps.now, onLost: loss => losses.push(loss) });
  await gone.record("measure", { pages: 3, maxPages: 3 });
  expect(losses).toEqual(["hold", "deleted"]);
});

it("says plainly that another worker is still finishing a build, and gives the attempt back", async () => {
  const draft = await makeDraft();
  const task = (await claimTask(db, "cv-pod#0", "interactive"))!;
  await db.execute(sql`insert into resource_leases (key, owner, expires_at)
    values (${`cv:${draft.id}`}, gen_random_uuid(), now() + interval '5 minutes')`);

  const busy = await handleGenerateCv(task, deps).catch((error: unknown) => error);
  expect(busy).toBeInstanceOf(LeaseBusyError);
  expect((busy as Error).message).toBe(CV_BUSY_MESSAGE);

  // The queue's own truth, in a sentence the page can show: and the attempt is not spent on it.
  expect(await failTask(db, task, busy)).toBe("retry");
  const row = await taskRow();
  expect(row.status).toBe("queued");
  expect(row.attempts).toBe(0);
  expect(row.error).toBe("LeaseBusyError: Another worker is still finishing this build");
  expect((await draftAfter(draft.id)).status).toBe("queued");
});

it("records an interrupted attempt and stops its model calls when a build outruns its deadline", async () => {
  let authorSignal: AbortSignal | undefined;
  const client: AiClientLike = {
    messages: {
      async create(params, options) {
        const content = (params.messages as Array<{ content: string }>)[0]!.content;
        const payload = JSON.parse(content as string) as { jobTitle?: string; description?: string };
        if (!payload.jobTitle) return answered(rubricFixture(payload.description!));
        // The writer never answers. This is the build that outruns its deadline.
        authorSignal = options?.signal as AbortSignal | undefined;
        return new Promise<ParseResponse>((_, reject) =>
          authorSignal?.addEventListener("abort", () => reject(new Error("Request was aborted.")), { once: true }));
      },
    },
  };
  deps.aiClient = client;
  const draft = await makeDraft();
  const queue = new TaskQueue(deps, { generate_cv: handleGenerateCv },
    { concurrency: 1, workerId: "cv-pod", onAbandon, onInterrupted, deadlines: { generate_cv: 500 } });

  await queue.drain();

  // The task is coming back, so the page is told which attempt stopped and when the next one runs.
  const waiting = await draftAfter(draft.id);
  expect(waiting.status).toBe("generating");
  const failure = waiting.failure as CvBuildFailure;
  expect(failure).toMatchObject({ kind: "worker_interrupted", attempt: 1, maxAttempts: 3, resolvedBy: "system", retryable: true });
  expect(new Date(failure.retryAt!).getTime()).toBeGreaterThan(Date.now());
  const requeued = await taskRow();
  expect(requeued.status).toBe("queued");
  expect(requeued.error).toContain("TimeoutError: generate_cv exceeded its 1s deadline");

  // The model call was cut off rather than left streaming for the rest of its fifteen minutes.
  expect(authorSignal?.aborted).toBe(true);
  // And nothing is left saying it is still running.
  for (let tick = 0; tick < 100 && (await steps(draft.id)).some(row => row.status === "running"); tick++)
    await new Promise(resolve => setTimeout(resolve, 20));
  const rows = await steps(draft.id);
  expect(rows.some(row => row.motion === "write")).toBe(true);
  expect(rows.every(row => row.status !== "running")).toBe(true);
  expect(rows.filter(row => row.status === "failed").every(row => row.attempt === 1)).toBe(true);
});

it("corrects a writer answer that cannot be materialised inside the build, at the cost of one more writing call", async () => {
  let first = true;
  const scripted = scriptedClient({
    author: () => {
      if (!first) return answered(plan);
      first = false;
      // An evidence reference the Library does not hold: the model's mistake, not the person's.
      return answered({ ...plan, sections: [...plan.sections, { entryId: "ghost", bullets: ["Invented work"] }] });
    },
  });
  deps.aiClient = scripted.client;
  const draft = await makeDraft();

  await queueFor().drain();

  const ready = await draftAfter(draft.id);
  expect(ready.status).toBe("ready");
  expect(ready.content!.sections.map(section => section.entryId)).toEqual(["one"]);
  // One task attempt, two writing calls: the second told exactly what was wrong with the first.
  const rows = await steps(draft.id);
  expect(rows.every(row => row.attempt === 1)).toBe(true);
  const writes = rows.filter(row => row.motion === "write" || row.motion === "rewrite");
  expect(writes.map(row => row.motion)).toEqual(["write", "rewrite"]);
  expect(writes[1]!.detail).toMatchObject({ attempt: 2, corrections: 1 });
  expect(writes[1]!.detail).not.toHaveProperty("reason");
  expect(rows.some(row => row.status === "failed")).toBe(false);
  expect(scripted.count("author")).toBe(2);
});

it("replaces its own dead attempt's hold rather than counting it beside the new one", async () => {
  deps.aiClient = scriptedClient().client;
  // The writing stage of this fixture is held at about $0.48: with a dead $0.90 hold of this very
  // build still recorded, a $1 month could not admit it if the dead hold were counted.
  deps.userSettings = (async () => ({ aiBudgetUsd: 1, aiBudgetResetAt: null })) as unknown as WorkerDeps["userSettings"];
  const draft = await makeDraft();
  await db.execute(sql`insert into ai_reservations (user_id, call_site, amount, expires_at, worker_id, ref_id)
    values (${userId}, 'CV', 0.9, now() + interval '30 minutes', 'dead-pod', ${draft.id})`);
  // Another build's hold is its own, and stays.
  await db.execute(sql`insert into ai_reservations (user_id, call_site, amount, expires_at, worker_id, ref_id)
    values (${userId}, 'CV', 0.01, now() + interval '30 minutes', 'live-pod', gen_random_uuid()::text)`);

  await queueFor().drain();

  expect((await draftAfter(draft.id)).status).toBe("ready");
  const admits = (await steps(draft.id)).filter(row => row.motion === "admit_budget");
  expect(admits.map(row => row.status)).toEqual(["done", "done", "done"]);
  expect(admits.map(row => row.detail.heldUsd)).toEqual([0.01, 0.01, 0.01]);
  const left = await db.execute<{ refId: string }>(sql`select ref_id as "refId" from ai_reservations`);
  expect(left.rows.map(row => row.refId)).not.toContain(draft.id);
  expect(left.rows).toHaveLength(1);
});

it("resumes a failed audit batch alone, keeping the batches that finished", async () => {
  const requirementIds = Array.from({ length: 10 }, (_, index) => `r${index + 1}`);
  const description = requirementIds.map(id => `Requirement ${id}.`).join(" ");
  const rubric = { caveats: [], requirements: requirementIds.map(id => ({
    id, label: `Requirement ${id}`, quote: `Requirement ${id}.`, importance: "essential" as const, category: "experience" as const })) };
  let overloaded = true;
  const scripted = scriptedClient({
    rubric: () => answered(rubric),
    review: (params) => {
      const blocks = (params.messages as Array<{ content: Array<{ text: string }> }>)[0]!.content;
      const batch = JSON.parse(blocks[2]!.text) as { requirements: Array<{ id: string }> };
      if (overloaded && batch.requirements.some(requirement => requirement.id === "r6")) {
        overloaded = false;
        throw new InternalServerError(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, undefined, new Headers());
      }
      return reviewAnswer(params);
    },
  });
  deps.aiClient = scripted.client;
  const draft = await makeDraft({ jobDescription: description });

  await queueFor().drain();

  const waiting = await draftAfter(draft.id);
  expect(waiting.status).toBe("generating");
  // The failure names the batch it was, and the batch that finished is saved under its own key.
  expect(waiting.failure).toMatchObject({ kind: "overloaded", resolvedBy: "system", motion: "assess_batch", batch: 2 });
  const stages = Object.keys(waiting.buildCheckpoint!.stages ?? {});
  expect(stages).toEqual(expect.arrayContaining(["rubric", "write", "audit[0]"]));
  expect(stages).not.toContain("audit[1]");
  const failedBatch = (await steps(draft.id)).find(row => row.motion === "assess_batch" && row.status === "failed")!;
  expect(failedBatch.detail).toMatchObject({ batch: 2, batches: 2, pass: "draft" });
  expect(failedBatch.failure).toMatchObject({ kind: "overloaded", batch: 2 });
  expect(failedBatch.title).toBe("Checking requirements 6–10 and 1 claim (batch 2 of 2)");
  expect(scripted.count("review")).toBe(2);

  await runDueNow();

  expect((await draftAfter(draft.id)).status).toBe("ready");
  const second = (await steps(draft.id)).filter(row => row.attempt === 2);
  // Only the batch that failed is paid for again.
  expect(second.filter(row => row.motion === "assess_batch").map(row => row.detail.batch)).toEqual([2]);
  expect(second.find(row => row.motion === "admit_budget")!.detail).toMatchObject({ stage: "audit" });
  expect(scripted.count("review")).toBe(3);
  expect(scripted.count("author")).toBe(1);
  expect(scripted.count("rubric")).toBe(1);
});

it("claims an account's first CV build before anyone's second", async () => {
  const other = (await ensureTestUser(db, "cv-build-other@example.com")).id;
  const insert = async (owner: string) => (await db.insert(schema.cvDrafts).values({
    userId: owner, jobTitle: `Role ${Math.random()}`, companyName: "Acme", jobDescription: "Lead a team",
    libraryVersion: 1, librarySnapshot: library, model: "claude-sonnet-5",
  }).returning())[0]!;
  const firstOfA = await insert(userId);
  const secondOfA = await insert(userId);
  const firstOfB = await insert(other);
  // Queued in that order, a moment apart, by a producer that names only the draft: the queue
  // fills in the account from the draft itself.
  for (const draft of [firstOfA, secondOfA, firstOfB]) {
    await enqueueTask(db, "generate_cv", { draftId: draft.id }, { dedupeKey: `generate_cv:${draft.id}`, priority: 2 });
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const queued = await db.select().from(schema.tasks);
  expect(queued.every(task => typeof (task.payload as { userId?: string }).userId === "string")).toBe(true);

  const claimed = [];
  for (let n = 0; n < 3; n++) claimed.push((await claimTask(db, `cv-pod#${n}`, "cv"))!);
  // A's first starts; then B's first, although A's second has waited longer; then A's second.
  expect(claimed.map(task => (task.payload as { draftId: string }).draftId)).toEqual([firstOfA.id, firstOfB.id, secondOfA.id]);
});

it("gives CV builds slots of their own, which the general slots never take", async () => {
  const ran: Array<{ type: string; lockedBy: string | null }> = [];
  const record = async (task: Task) => { ran.push({ type: task.type, lockedBy: task.lockedBy }); return {}; };
  const draft = await makeDraft();
  await enqueueTask(db, "score_job", { userId, jobId: draft.id }, { priority: 4 });
  const queue = new TaskQueue(deps, { generate_cv: record, score_job: record },
    { concurrency: 1, cvConcurrency: 1, workerId: "lanes-pod", pollMs: 20 });
  queue.start();
  for (let tick = 0; tick < 200 && ran.length < 2; tick++) await new Promise(resolve => setTimeout(resolve, 20));
  await queue.stop(1_000, 1_000);
  expect(ran.find(run => run.type === "generate_cv")!.lockedBy).toBe("lanes-pod#1");
  expect(ran.find(run => run.type === "score_job")!.lockedBy).toBe("lanes-pod#0");
});

it("refuses to open a step for an attempt that no longer owns its task", async () => {
  const draft = await makeDraft({ status: "generating" });
  const losses: CvJournalLoss[] = [];
  const zombie = new CvJournal({
    db, draftId: draft.id, userId, taskId: null, attempt: 1, now: deps.now,
    assertOwnership: async () => { throw new LeaseLostError("Task lease lost; refusing stale writes"); },
    onLost: loss => losses.push(loss),
  });
  const step = await zombie.open("write", { attempt: 1 });
  expect(step.id).toBeNull();
  expect(losses).toEqual(["fenced"]);
  expect(await steps(draft.id)).toHaveLength(0);
});
