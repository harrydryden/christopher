/**
 * The CV page's progress feed against a real database: what it costs, what it returns, and that the
 * token and signature it answers are the ones the page renders from the same rows — otherwise the
 * page would re-render itself on every reading.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { sql } from "drizzle-orm";
import { createTestDb } from "@/test/db";
import { ensureTestUser } from "@/test/auth";
import type { User } from "@ava/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let user: User;
let signedIn: User | null = null;
/** Every statement the route sends, so the test can hold it to one query beside the session. */
const statements = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/db", () => ({
  db: () =>
    new Proxy(database, {
      get(target, key, receiver) {
        if (key === "execute" || key === "select") statements.count++;
        return Reflect.get(target, key, receiver);
      },
    }),
}));
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => {
    if (!signedIn) throw new Error("Unauthorised");
    return signedIn;
  }),
}));

import { GET } from "./route";
import { getOwnCvDraft, readCvProgress } from "@/lib/queries/cv";
import { cvProgressReading } from "@/lib/cv-progress";
import { cvStepsSignature } from "@/lib/cv-build-state";
import type { CvProgressReading } from "@/lib/cv-progress-types";

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
afterAll(() => pool.end());
beforeEach(async () => {
  await database.execute(sql`truncate cv_drafts, tasks, users restart identity cascade`);
  user = await ensureTestUser(database, "cv-progress@example.com");
  signedIn = user;
  statements.count = 0;
});

async function seed() {
  const [draft] = await database
    .insert(schema.cvDrafts)
    .values({
      userId: user.id, jobTitle: "Director", companyName: "Example", jobDescription: "Lead a team.", libraryVersion: 1,
      librarySnapshot: { name: "Example", contact: "", profile: "Leader", entries: [] }, model: "test",
      status: "generating", buildStage: "assessing", progressAt: new Date(),
    })
    .returning();
  const [task] = await database
    .insert(schema.tasks)
    .values({ type: "generate_cv", payload: { draftId: draft!.id }, dedupeKey: `generate_cv:${draft!.id}`, status: "running", attempts: 1, maxAttempts: 3, startedAt: new Date() })
    .returning();
  // Written with the database's clock, microseconds and all, as the worker writes them.
  await database.execute(sql`
    insert into cv_build_steps (draft_id, user_id, task_id, attempt, seq, stage, motion, title, status, started_at, finished_at, ms, detail) values
      (${draft!.id}, ${user.id}, ${task!.id}, 1, 1, 'preparing', 'load_inputs', 'Reading', 'done', now() - interval '3 minutes', now() - interval '179 seconds', 1000, '{"maxAttempts":3}'),
      (${draft!.id}, ${user.id}, ${task!.id}, 1, 2, 'assessing', 'assess_batch', 'Checking', 'done', now() - interval '1 minute', now() - interval '30 seconds', 30000, '{"pass":"draft","index":1,"of":2}'),
      (${draft!.id}, ${user.id}, ${task!.id}, 1, 3, 'assessing', 'assess_batch', 'Checking', 'running', now() - interval '59 seconds', null, null, '{"pass":"draft","index":2,"of":2}')`);
  return { draft: draft!, task: task! };
}

const read = async (id: string, query = "") => {
  const response = await GET(new Request(`http://localhost/api/cv/${id}/progress${query}`), { params: Promise.resolve({ id }) });
  return { status: response.status, headers: response.headers, body: (await response.json()) as CvProgressReading };
};

it("answers the page's own token and signature, from one query beside the session", async () => {
  const { draft } = await seed();
  // The page: the full draft it renders, and the same progress read the feed makes.
  const rows = await readCvProgress(user.id, draft.id);
  const fullDraft = await getOwnCvDraft(user.id, draft.id);
  const page = cvProgressReading({ ...rows!, draft: fullDraft! });
  statements.count = 0;

  const { status, headers, body } = await read(draft.id);
  expect(status).toBe(200);
  expect(headers.get("cache-control")).toContain("no-store");
  // The session lookup is mocked here; the route itself sends exactly one statement.
  expect(statements.count).toBe(1);
  expect(body.version).toBe(page.version);
  expect(body.version).toBe("generating:::");
  expect(body.signature).toBe(page.signature);
  expect(body.signature).toBe(cvStepsSignature(rows!.steps));
  expect(body).toMatchObject({ active: true, live: true, phase: "progressing", status: "generating" });
  expect(body.steps.map((step) => step.seq)).toEqual([1, 2, 3]);
  expect(body.steps[0]!.taskId).toMatch(/^[0-9a-f-]{36}$/);
});

it("returns only what moved since the reader's last look", async () => {
  const { draft } = await seed();
  const { body: first } = await read(draft.id);
  const sig = encodeURIComponent(first.signature);
  const { body: quiet } = await read(draft.id, `?after=3&sig=${sig}`);
  // Nothing new: the one row still open, so its elapsed figure has a row to count from.
  expect(quiet.steps.map((step) => step.seq)).toEqual([3]);
  expect(quiet.signature).toBe(first.signature);

  await database.execute(sql`update cv_build_steps set status = 'done', finished_at = now(), ms = 59000 where draft_id = ${draft.id} and seq = 3`);
  const { body: moved } = await read(draft.id, `?after=3&sig=${sig}`);
  expect(moved.steps.map((step) => `${step.seq}:${step.status}`)).toEqual(["3:done"]);
  expect(moved.signature).not.toBe(first.signature);
});

it("answers another account's draft exactly as it answers a draft that does not exist", async () => {
  const { draft } = await seed();
  signedIn = await ensureTestUser(database, "cv-progress-stranger@example.com");
  const foreign = await read(draft.id);
  const missing = await read(crypto.randomUUID());
  expect(foreign.status).toBe(404);
  expect({ status: foreign.status, body: foreign.body, cache: foreign.headers.get("cache-control") }).toEqual({
    status: missing.status, body: missing.body, cache: missing.headers.get("cache-control"),
  });
});

it("refuses what it should, and answers a worker behind the interface without an error", async () => {
  const { draft } = await seed();
  expect((await read("not-a-uuid")).status).toBe(400);
  expect((await read(crypto.randomUUID())).status).toBe(404);
  signedIn = null;
  expect((await read(draft.id)).status).toBe(401);
  signedIn = user;

  // A release serving before the ledger's migration: the draft and its task, and no rows.
  await database.execute(sql`alter table cv_build_steps rename to cv_build_steps_hidden`);
  try {
    const { status, body } = await read(draft.id);
    expect(status).toBe(200);
    expect(body.steps).toEqual([]);
    expect(body.version).toBe("generating:::");
  } finally {
    await database.execute(sql`alter table cv_build_steps_hidden rename to cv_build_steps`);
  }
});
