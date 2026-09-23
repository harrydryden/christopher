/**
 * The queue's dedupe rule, which lives in partial unique indexes: a key has at most one task that
 * is queued and has never started. A task already running does not absorb a new enqueue, so work
 * asked for while it runs gets one follow-up that reads the state as it is by then. CV builds are
 * the exception, one per draft whether queued or running.
 *
 * Requires a database: set TEST_DATABASE_URL (defaults to the local ava_test database).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb } from "./client";
import { runMigrations } from "./migrate";
import { tasks } from "./schema";
import { activeTaskFor, enqueueTask } from "./tasks";

const { db, pool } = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test", { max: 1 });
beforeAll(() => runMigrations(db));
beforeEach(() => db.execute(sql`truncate tasks`));
afterAll(() => pool.end());

const key = "review_library:00000000-0000-4000-8000-000000000001";
const review = () => enqueueTask(db, "review_library", { userId: "00000000-0000-4000-8000-000000000001" }, { dedupeKey: key });
/** What the queue's claim does to a row. */
const claim = (id: string) => db.update(tasks).set({ status: "running", startedAt: new Date(), attempts: sql`${tasks.attempts} + 1` }).where(eq(tasks.id, id));
const rows = () => db.select({ id: tasks.id, status: tasks.status }).from(tasks).orderBy(tasks.createdAt);

describe("the dedupe key", () => {
  it("absorbs a second enqueue while the first is still waiting", async () => {
    expect(await review()).toBeTruthy();
    expect(await review()).toBeNull();
    expect(await rows()).toHaveLength(1);
  });

  it("queues one follow-up when the enqueue lands while the task runs, and only one", async () => {
    // A library saved while its review pass is running: the pass read the old version.
    const first = await review();
    await claim(first!);
    const followUp = await review();
    expect(followUp).toBeTruthy();
    expect(await review()).toBeNull();
    expect((await rows()).map(row => row.status)).toEqual(["running", "queued"]);
  });

  it("never refuses a running task going back to the queue beside its follow-up", async () => {
    const first = await review();
    await claim(first!);
    await review();
    // A retry, a stale sweep and a shutdown hand-back all put the running row back to queued. The
    // follow-up already holds the key, and neither may fail for it.
    await db.update(tasks).set({ status: "queued", lockedAt: null, lockedBy: null }).where(eq(tasks.id, first!));
    expect((await rows()).map(row => row.status)).toEqual(["queued", "queued"]);
  });

  it("keeps one CV build per draft, queued or running, so a rebuild waits for the last to finish", async () => {
    const draftKey = "generate_cv:00000000-0000-4000-8000-000000000002";
    const build = () => enqueueTask(db, "generate_cv", { draftId: "00000000-0000-4000-8000-000000000002" }, { dedupeKey: draftKey });
    const first = await build();
    await claim(first!);
    expect(await build()).toBeNull();
    // A retry of the running build still goes back to the queue.
    await db.update(tasks).set({ status: "queued" }).where(eq(tasks.id, first!));
    expect(await build()).toBeNull();
    await db.update(tasks).set({ status: "done", finishedAt: new Date() }).where(eq(tasks.id, first!));
    expect(await build()).toBeTruthy();
  });

  it("is free again once the task has finished", async () => {
    const first = await review();
    await claim(first!);
    await db.update(tasks).set({ status: "done", finishedAt: new Date() }).where(eq(tasks.id, first!));
    expect(await review()).toBeTruthy();
  });

  it("still finds what is queued or running for a key through an index", async () => {
    const first = await review();
    await claim(first!);
    expect((await activeTaskFor(db, key))?.id).toBe(first);
    const plan = await db.transaction(async tx => {
      await tx.execute(sql`set local enable_seqscan = off`);
      return (await tx.execute(sql`explain select * from tasks where dedupe_key = ${key} and status in ('queued', 'running') limit 1`)).rows;
    });
    expect(JSON.stringify(plan)).toContain("tasks_dedupe_active_idx");
  });
});
