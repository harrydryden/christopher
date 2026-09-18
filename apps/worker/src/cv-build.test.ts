/**
 * What a CV build says about itself, and what it does when something goes wrong.
 *
 * These drive the real engine through a scripted client rather than stubbing `AiEngine`, because
 * the things under test are the engine's own: which class a provider threw, whether a batch was
 * re-run, what each call cost. The queue is real too, so a retry is a real requeue with a real
 * backoff and a real second claim.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { enqueueTask, listCvBuildSteps, schema, startCvBuildStep, type Db } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { InternalServerError, RateLimitError, type AiClientLike, type ParseResponse } from "@christopher/ai";
import { DEFAULT_CV_THEME } from "@christopher/core/cv";
import type { CvBuildFailure, CvBuildStepView } from "@christopher/core";
import { dedupeKeyFor } from "@christopher/core";
import { eq, sql } from "drizzle-orm";
import { rubricFixture, reviewFixture } from "../../../packages/core/test/cv-review-fixture";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { claimTask, requeueStale, TaskQueue, TASK_STALE_AFTER_MS } from "./queue";
import { handleGenerateCv } from "./handlers/cv";
import { CV_ABANDONED_MESSAGE, onAbandon } from "./handlers/abandon";
import { ensureTestUser } from "./test-users";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test";

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
  process.env.CHRISTOPHER_DISABLE_BROWSER = "1";
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
  await db.execute(sql`truncate tasks, applications, cv_build_steps, cv_drafts, ai_calls, ai_reservations, worker_events`);
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
  const payload = { draftId: draft!.id };
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
  await db.update(schema.tasks).set({ runAfter: new Date() });
  await queueFor().drain();
}

it("narrates every motion of a clean build, with the figures and the cost of each model call", async () => {
  const scripted = scriptedClient();
  deps.aiClient = scripted.client;
  const draft = await makeDraft();

  await queueFor().drain();

  const rows = await steps(draft.id);
  expect(motions(rows)).toEqual([
    "load_inputs", "admit_budget", "rubric", "write", "check_plan", "measure", "assess_batch", "assemble", "publish",
  ]);
  expect(rows.every(row => row.status === "done")).toBe(true);
  expect(rows.every(row => row.attempt === 1 && row.finishedAt !== null && row.ms !== null)).toBe(true);
  const byMotion = Object.fromEntries(rows.map(row => [row.motion, row]));

  expect(byMotion.load_inputs!.detail).toEqual({
    libraryVersion: 1, roles: 1, qualifications: 0, skillBlocks: 0, descriptionCharacters: 11,
    mode: "build", reusedRubric: false, reusedContent: false,
  });
  expect(byMotion.admit_budget!.detail).toMatchObject({ limitUsd: 1000, leftUsd: expect.any(Number) });
  expect(byMotion.admit_budget!.detail.expectedUsd as number).toBeGreaterThan(0);
  expect(byMotion.admit_budget!.detail.heldUsd).toBe(byMotion.admit_budget!.detail.expectedUsd);

  expect(byMotion.rubric!.detail).toMatchObject({ requirements: 1, essential: 1, desirable: 0, responsibilities: 0 });
  expect(byMotion.write!.title).toBe("Writing the CV");
  expect(byMotion.write!.detail).toMatchObject({ attempt: 1, budgetScale: 1, maxPages: 3, roles: 1, bullets: 1 });
  expect(byMotion.write!.detail.budgetCharacters as number).toBeGreaterThan(0);
  expect(byMotion.write!.detail.characters).toBe(plan.summary.length + "Led a team".length);
  expect(byMotion.check_plan!.detail).toEqual({ omitted: [], skillFormatCorrections: 0 });
  expect(byMotion.measure!.detail).toEqual({ pages: 1, maxPages: 3 });
  expect(byMotion.assess_batch!.title).toBe("Checking requirements 1–1 and 2 claims (batch 1 of 1)");
  expect(byMotion.assess_batch!.detail).toMatchObject({ batch: 1, batches: 1, requirements: 1, claims: 2 });
  expect(byMotion.assemble!.detail).toEqual({
    demonstrated: 1, partial: 0, missing: 0, unknown: 0, supported: 2, unsupported: 0, uncertain: 0, pageCount: 1,
  });
  expect(byMotion.publish!.detail).toEqual({ revision: 1, archivedPrevious: false });

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
  expect(motions(second)).toEqual(["load_inputs", "admit_budget", "rubric", "write", "check_plan", "measure", "assess_batch", "assemble", "publish"]);
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
  // Both charges are the audit's, and the engine names the second separately in the call log.
  expect(await aiCallsByStage()).toEqual({ rubric: 1, author: 1, review: 1, review_retry: 1 });
});

it("refuses a build the account cannot afford before any model call, and asks for the budget", async () => {
  const scripted = scriptedClient();
  deps.aiClient = scripted.client;
  deps.userSettings = (async () => ({ aiBudgetUsd: 0.05, aiBudgetResetAt: null })) as unknown as WorkerDeps["userSettings"];
  const draft = await makeDraft();

  await queueFor().drain();

  const refused = await draftAfter(draft.id);
  expect(refused.status).toBe("failed");
  expect(refused.failure).toMatchObject({ kind: "budget_exhausted", resolvedBy: "user", retryable: false, action: "raise_budget" });
  expect(refused.error).toContain("your budget of $0.05");
  const rows = await steps(draft.id);
  expect(motions(rows)).toEqual(["load_inputs", "admit_budget"]);
  const admit = rows[1]!;
  expect(admit.status).toBe("failed");
  expect(admit.detail).toMatchObject({ limitUsd: 0.05, heldUsd: 0, leftUsd: 0.05 });
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
  const writes = rows.filter(row => row.motion === "write");
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
  expect(motions(second)).toEqual(["load_inputs", "admit_budget", "rubric", "measure", "assess_batch", "assemble", "publish"]);
  expect(second.find(row => row.motion === "load_inputs")!.detail).toMatchObject({ reusedRubric: true, reusedContent: true });
  expect(second.find(row => row.motion === "rubric")!.status).toBe("skipped");
  expect(second.some(row => row.motion === "write")).toBe(false);
  expect(rows.filter(row => row.motion === "assess_batch").map(row => row.attempt)).toEqual([1, 2]);

  expect((await draftAfter(draft.id)).status).toBe("ready");
  // One rubric, one author, two audits: the retry cost the audit alone.
  expect(await aiCallsByStage()).toEqual({ rubric: 1, author: 1, review: 2 });
  const spentOnRetry = await db.execute<{ total: number }>(sql`select coalesce(sum(cost_usd::float8), 0) as total from ai_calls where stage = 'review'`);
  const spentOnWriting = await db.execute<{ total: number }>(sql`select coalesce(sum(cost_usd::float8), 0) as total from ai_calls where stage in ('rubric', 'author')`);
  expect(Number(spentOnRetry.rows[0]!.total)).toBeGreaterThan(0);
  expect(Number(spentOnWriting.rows[0]!.total)).toBeGreaterThan(0);
});

it("closes the narrative of a build whose worker died, with the taxonomy the page reads", async () => {
  const draft = await makeDraft({ status: "generating", buildStage: "writing" });
  const task = (await claimTask(db, "dead-pod#0", "interactive"))!;
  await db.update(schema.tasks).set({ attempts: 3, lockedAt: new Date(Date.now() - 60 * 60_000) }).where(eq(schema.tasks.id, task.id));
  await startCvBuildStep(db, { draftId: draft.id, userId, taskId: task.id, attempt: 3, motion: "write" });
  await db.execute(sql`insert into ai_reservations (user_id, call_site, amount, expires_at, worker_id)
    values (${userId}, 'CV', 3.06, now() + interval '30 minutes', 'dead-pod')`);

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
