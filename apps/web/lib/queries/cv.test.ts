/**
 * Reading a CV draft, in the two situations the interface actually meets.
 *
 * The first is a database the worker has not finished migrating: the interface deploys on its own
 * and the worker runs the migrations, so for a few minutes a release can be serving against a
 * `cv_drafts` without the columns a build records itself in. Every CV page and every status poll
 * reads that table, so a missing column is not a degraded page but a 500 on all of them.
 *
 * The second is the page and its poll agreeing about the ledger: the page signs the rows it has
 * already read, `/api/work-status` signs them in SQL, and the two strings are compared against each
 * other every ten seconds.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, cvBuildStepsSignature, schema, type Db } from "@ava/db";
import { createTestDb } from "@/test/db";
import { runMigrations } from "@ava/db/migrate";
import { sql } from "drizzle-orm";
import { cvStepsSignature, cvWorkVersion, normaliseCvStepsSignature } from "@/lib/cv-build-state";
import { ensureTestUser } from "@/test/auth";
import type { User } from "@ava/db/schema";
import type { CvBuildFailure } from "@ava/core";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let user: User;
vi.mock("@/lib/db", () => ({ db: () => database }));
import { cvWorkVersionFor, getOwnCvBuildSteps, getOwnCvBuildTask, getOwnCvDraft, getOwnCvWorkRow } from "./cv";
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

    const row = await getOwnCvWorkRow(user.id, draft.id);
    expect(row).toMatchObject({ id: draft.id, status: "generating", buildStage: "writing", progressAt: null, failure: null });
    expect(await cvWorkVersionFor(row!)).toContain("generating:writing");
    // Somebody else's draft is nobody's to read, whatever the schema is doing.
    expect(await getOwnCvDraft(crypto.randomUUID(), draft.id)).toBeNull();
    expect(await getOwnCvWorkRow(crypto.randomUUID(), draft.id)).toBeNull();
  } finally {
    for (const column of BUILD_COLUMNS) await database.execute(sql.raw(`alter table cv_drafts rename column ${column}_hidden to ${column}`));
  }

  // The worker catches up: the same process picks the columns back up without a redeploy.
  const migrated = await getOwnCvDraft(user.id, draft.id);
  expect(migrated!.failure).toMatchObject({ kind: "overloaded", attempt: 1 });
  expect(migrated!.buildCheckpoint).toMatchObject({ attempt: 1 });
  expect(migrated!.progressAt).toBeInstanceOf(Date);
  expect((await getOwnCvWorkRow(user.id, draft.id))!.failure).toMatchObject({ kind: "overloaded" });
});

it("signs the ledger the same way from the page's rows and from the poll's query", async () => {
  const draft = await seedDraft();
  const base = { draftId: draft.id, userId: user.id, attempt: 1, detail: {} };
  await database.insert(schema.cvBuildSteps).values([
    { ...base, seq: 1, stage: "preparing", motion: "load_inputs", title: "Reading your Library and the role", status: "done",
      startedAt: new Date(Date.now() - 120_000), finishedAt: new Date(Date.now() - 119_000), ms: 900 },
    { ...base, seq: 2, stage: "analysing", motion: "rubric", title: "Extracting the role's requirements", status: "done",
      startedAt: new Date(Date.now() - 118_000), finishedAt: new Date(Date.now() - 66_000), ms: 52_000 },
  ]);
  // The worker's own writes take the database's clock, which keeps microseconds that a parsed Date
  // cannot: the page's signature and the poll's must still be one string.
  await database.execute(sql`
    insert into cv_build_steps (draft_id, user_id, attempt, seq, stage, motion, title, status, started_at)
    values (${draft.id}, ${user.id}, 1, 3, 'writing', 'write', 'Writing the CV', 'running', now())`);

  const steps = await getOwnCvBuildSteps(user.id, draft.id);
  expect(steps).toHaveLength(3);
  const signature = cvStepsSignature(steps);
  expect(signature).toMatch(/^3:1:/);
  expect(signature).toBe(normaliseCvStepsSignature(await cvBuildStepsSignature(database, draft.id)));

  // Which is the whole point: the token the page renders is the token the poll answers with, so a
  // page with nothing new to show does not refresh itself every ten seconds.
  const now = new Date();
  expect(cvWorkVersion(draft, now, signature)).toBe(await cvWorkVersionFor(draft, now));

  // A motion closing moves both of them together.
  await database.execute(sql`update cv_build_steps set status = 'done', finished_at = now(), ms = 30000 where draft_id = ${draft.id} and status = 'running'`);
  const closed = cvStepsSignature(await getOwnCvBuildSteps(user.id, draft.id));
  expect(closed).not.toBe(signature);
  expect(closed).toBe(normaliseCvStepsSignature(await cvBuildStepsSignature(database, draft.id)));
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
