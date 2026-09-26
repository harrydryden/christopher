/**
 * Reading a CV draft, in the two situations the interface actually meets.
 *
 * The first is a database the worker has not finished migrating: the interface deploys on its own
 * and the worker runs the migrations, so for a few minutes a release can be serving against a
 * `cv_drafts` without the columns a build records itself in. Every CV page and every status poll
 * reads that table, so a missing column is not a degraded page but a 500 on all of them.
 *
 * The second is the page and its progress feed agreeing about the ledger: the feed signs the whole
 * ledger in SQL while returning only the rows the reader lacks, the reader signs the rows it holds,
 * and a reader whose signature differs reads the ledger again whole.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@ava/db";
import { createTestDb } from "@/test/db";
import { runMigrations } from "@ava/db/migrate";
import { sql } from "drizzle-orm";
import { cvStepsSignature } from "@/lib/cv-build-state";
import { mergeSteps } from "@/lib/cv-build-journal";
import { cvProgressReading } from "@/lib/cv-progress";
import { ensureTestUser } from "@/test/auth";
import type { User } from "@ava/db/schema";
import type { CvBuildFailure } from "@ava/core";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let user: User;
vi.mock("@/lib/db", () => ({ db: () => database }));
import { getOwnCvBuildTask, getOwnCvDraft, readCvProgress } from "./cv";
import { getCvWorkStatus } from "@/lib/work-status";

const BUILD_COLUMNS = ["progress_at", "build_checkpoint", "failure", "gap_quiz"] as const;

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
afterAll(() => pool.end());
beforeEach(async () => {
  await database.execute(sql`truncate cv_drafts, users restart identity cascade`);
  user = await ensureTestUser(database, "cv-queries@example.com");
});

const failure: CvBuildFailure = {
  kind: "overloaded",
  resolvedBy: "system",
  retryable: true,
  message: "The model provider is overloaded.",
  motion: "write",
  attempt: 1,
  maxAttempts: 3,
};

async function seedDraft(values: Partial<typeof schema.cvDrafts.$inferInsert> = {}) {
  const [draft] = await database
    .insert(schema.cvDrafts)
    .values({
      userId: user.id,
      jobTitle: "Operations Director",
      companyName: "Example",
      jobDescription: "Lead a team.",
      libraryVersion: 1,
      librarySnapshot: { name: "Example", contact: "", profile: "Leader", entries: [] },
      model: "test",
      status: "generating",
      buildStage: "writing",
      ...values,
    })
    .returning();
  return draft!;
}

/**
 * This one runs first on purpose. The column probe remembers a database that has every column,
 * because a migrated database never un-migrates, so a test that hid them afterwards would be
 * asking the query to disbelieve something that cannot happen.
 */
it("reads a draft and its poll row from a database the worker has not migrated yet", async () => {
  const draft = await seedDraft({
    progressAt: new Date(Date.now() - 60_000),
    buildCheckpoint: { rubricAt: new Date().toISOString(), attempt: 1 },
    failure,
    content: null,
  });

  for (const column of BUILD_COLUMNS) await database.execute(sql.raw(`alter table cv_drafts rename column ${column} to ${column}_hidden`));
  try {
    const behind = await getOwnCvDraft(user.id, draft.id);
    expect(behind).toMatchObject({ id: draft.id, jobTitle: "Operations Director", status: "generating", buildStage: "writing" });
    // A build nothing has recorded yet reads as one that recorded nothing, never as an error page.
    expect(behind).toMatchObject({ progressAt: null, buildCheckpoint: null, failure: null });

    const rows = await readCvProgress(user.id, draft.id);
    expect(rows!.draft).toMatchObject({ status: "generating", buildStage: "writing", progressAt: null, failure: null });
    expect(rows!.steps).toEqual([]);
    // Nothing queued behind it: a build nothing is working on, said as stopped, never a 500.
    expect(cvProgressReading(rows!).version).toBe("generating:::stopped");
    // Somebody else's draft is nobody's to read, whatever the schema is doing.
    expect(await getOwnCvDraft(crypto.randomUUID(), draft.id)).toBeNull();
    expect(await readCvProgress(crypto.randomUUID(), draft.id)).toBeNull();
  } finally {
    for (const column of BUILD_COLUMNS) await database.execute(sql.raw(`alter table cv_drafts rename column ${column}_hidden to ${column}`));
  }

  // The worker catches up: the same process picks the columns back up without a redeploy.
  const migrated = await getOwnCvDraft(user.id, draft.id);
  expect(migrated!.failure).toMatchObject({ kind: "overloaded", attempt: 1 });
  expect(migrated!.buildCheckpoint).toMatchObject({ attempt: 1 });
  expect(migrated!.progressAt).toBeInstanceOf(Date);
  expect((await readCvProgress(user.id, draft.id))!.draft.failure).toMatchObject({ kind: "overloaded" });
});

it("signs the whole ledger in SQL the way a reader signs the rows it holds, and sends only what moved", async () => {
  const draft = await seedDraft();
  const base = { draftId: draft.id, userId: user.id, attempt: 1, detail: {} };
  await database.insert(schema.cvBuildSteps).values([
    { ...base, seq: 1, stage: "preparing", motion: "load_inputs", title: "Reading your Library and the role", status: "done",
      startedAt: new Date(Date.now() - 120_000), finishedAt: new Date(Date.now() - 119_000), ms: 900 },
    { ...base, seq: 2, stage: "analysing", motion: "rubric", title: "Extracting the role's requirements", status: "done",
      startedAt: new Date(Date.now() - 118_000), finishedAt: new Date(Date.now() - 66_000), ms: 52_000 },
  ]);
  // The worker's own writes take the database's clock, which keeps microseconds that a parsed Date
  // cannot: the two signatures must still be one string.
  await database.execute(sql`
    insert into cv_build_steps (draft_id, user_id, attempt, seq, stage, motion, title, status, started_at)
    values (${draft.id}, ${user.id}, 1, 3, 'writing', 'write', 'Writing the CV', 'running', now())`);

  const full = await readCvProgress(user.id, draft.id);
  expect(full!.steps.map((step) => step.seq)).toEqual([1, 2, 3]);
  expect(full!.signature).toMatch(/^3:1:/);
  expect(cvStepsSignature(full!.steps)).toBe(full!.signature);

  // A reader holding all three asks for what moved after seq 3: only the open row comes back.
  const quiet = await readCvProgress(user.id, draft.id, { after: 3, last: new Date(full!.signature.split(":").slice(2).join(":")) });
  expect(quiet!.steps.map((step) => step.seq)).toEqual([3]);

  // The open row closes and a fourth opens: both come back, and the merged rows sign as the ledger.
  await database.execute(sql`update cv_build_steps set status = 'done', finished_at = now(), ms = 30000 where draft_id = ${draft.id} and status = 'running'`);
  await database.execute(sql`
    insert into cv_build_steps (draft_id, user_id, attempt, seq, stage, motion, title, status, started_at)
    values (${draft.id}, ${user.id}, 1, 4, 'writing', 'check_plan', 'Checking', 'running', now())`);
  const delta = await readCvProgress(user.id, draft.id, { after: 3, last: new Date(full!.signature.split(":").slice(2).join(":")) });
  expect(delta!.steps.map((step) => `${step.seq}:${step.status}`)).toEqual(["3:done", "4:running"]);
  const merged = mergeSteps(full!.steps, delta!.steps);
  expect(cvStepsSignature(merged)).toBe(delta!.signature);
  expect(merged.map((step) => step.seq)).toEqual([1, 2, 3, 4]);
});

it("reads the older way only when the schema is behind, and lets any other failure through", async () => {
  const draft = await seedDraft();
  const real = database;
  let selects = 0;
  const failing = (code: string) =>
    new Proxy(real, {
      get(target, key, receiver) {
        if (key === "execute") return async () => { throw Object.assign(new Error(`failed with ${code}`), { code }); };
        if (key === "select") selects += 1;
        return Reflect.get(target, key, receiver);
      },
    });
  try {
    // A statement timeout is this reading failing: the poller backs off, and nothing reads again.
    database = failing("57014");
    await expect(readCvProgress(user.id, draft.id)).rejects.toThrow("failed with 57014");
    expect(selects).toBe(0);
    // A missing column, even wrapped by the driver, is a worker that has not migrated yet.
    database = new Proxy(real, {
      get(target, key, receiver) {
        if (key === "execute") return async () => { throw Object.assign(new Error("query failed"), { cause: Object.assign(new Error("no column"), { code: "42703" }) }); };
        return Reflect.get(target, key, receiver);
      },
    });
    expect((await readCvProgress(user.id, draft.id))!.draft.status).toBe("generating");
  } finally {
    database = real;
  }
});

it("reads another account's ledger rows as nobody's, even through its own draft id", async () => {
  const draft = await seedDraft();
  const stranger = await ensureTestUser(database, "cv-queries-stranger@example.com");
  await database.insert(schema.cvBuildSteps).values({
    draftId: draft.id, userId: stranger.id, attempt: 1, seq: 1, stage: "preparing", motion: "load_inputs", title: "x", status: "done", detail: {},
  });
  const rows = await readCvProgress(user.id, draft.id);
  expect(rows!.steps).toEqual([]);
  expect(rows!.signature).toBe("0:0:");
});

it("reads the quiz continuation task rather than the completed task that paused", async () => {
  const draft = await seedDraft({ status: "queued" });
  await database.insert(schema.tasks).values([
    {
      type: "generate_cv", payload: { draftId: draft.id }, dedupeKey: `generate_cv:${draft.id}`,
      status: "done", attempts: 1, startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(Date.now() - 30_000),
    },
    {
      type: "generate_cv", payload: { draftId: draft.id }, dedupeKey: `generate_cv:${draft.id}:quiz-complete`,
      status: "queued", attempts: 0,
    },
  ]);
  expect(await getOwnCvBuildTask(user.id, draft.id)).toMatchObject({ status: "queued", attempts: 0, startedAt: null });
  expect(await getOwnCvBuildTask(crypto.randomUUID(), draft.id)).toBeNull();
});

it("includes a quiz continuation task in account CV work status", async () => {
  const draft = await seedDraft({ status: "queued" });
  await database.insert(schema.tasks).values({
    type: "generate_cv", payload: { draftId: draft.id }, dedupeKey: `generate_cv:${draft.id}:quiz-complete`,
    status: "queued", attempts: 0,
  });
  const status = await getCvWorkStatus(user.id);
  expect(status.active).toBe(true);
  expect(status.version).not.toBe("");
});

it("follows a ready CV while its improvement runs, and never moves for a budget admission", async () => {
  const draft = await seedDraft({ status: "ready", buildStage: null });
  expect((await getCvWorkStatus(user.id)).active).toBe(false);
  // The improvement pass after publication: its queue row is still running.
  await database.insert(schema.tasks).values({ type: "generate_cv", payload: { draftId: draft.id }, dedupeKey: `generate_cv:${draft.id}`, status: "running", attempts: 1 });
  const step = (seq: number, motion: string, status: "running" | "done" = "running") =>
    database.insert(schema.cvBuildSteps).values({
      draftId: draft.id, userId: user.id, attempt: 1, seq, stage: "assessing", motion: motion as "improve_content", title: motion, status, detail: {},
    });
  await step(1, "improve_content");
  const improving = await getCvWorkStatus(user.id);
  expect(improving).toMatchObject({ active: true, improving: [draft.id] });
  // The re-check's admission opens and closes around the pass: the version does not move for it.
  await step(2, "admit_budget");
  expect((await getCvWorkStatus(user.id)).version).toBe(improving.version);
  await database.update(schema.cvBuildSteps).set({ status: "done" }).where(sql`seq = 2`);
  expect((await getCvWorkStatus(user.id)).version).toBe(improving.version);

  // The queue row finishes and nothing is open: the pass is over, and the version moves once more.
  await database.update(schema.tasks).set({ status: "done" });
  await database.update(schema.cvBuildSteps).set({ status: "done" });
  const over = await getCvWorkStatus(user.id);
  expect(over).toMatchObject({ active: false, improving: [] });
  expect(over.version).not.toBe(improving.version);
  // A running row left by a process that died long ago is not work.
  await step(3, "compare_content");
  await database.update(schema.cvBuildSteps).set({ startedAt: new Date(Date.now() - 60 * 60_000) }).where(sql`seq = 3`);
  expect((await getCvWorkStatus(user.id)).active).toBe(false);
});

it("moves the account's CV version once per motion, not once per batch", async () => {
  const draft = await seedDraft({ status: "generating" });
  const step = (seq: number, motion: string, detail: Record<string, unknown> = {}) =>
    database.insert(schema.cvBuildSteps).values({
      draftId: draft.id, userId: user.id, attempt: 1, seq, stage: "assessing", motion: motion as "assess_batch", title: motion, status: "running", detail,
    });
  await step(1, "measure");
  const measuring = (await getCvWorkStatus(user.id)).version;
  await step(2, "assess_batch", { index: 1, of: 3 });
  const batch1 = (await getCvWorkStatus(user.id)).version;
  await step(3, "assess_batch", { index: 2, of: 3 });
  const batch2 = (await getCvWorkStatus(user.id)).version;
  expect(batch1).not.toBe(measuring);
  expect(batch2).toBe(batch1);
});
