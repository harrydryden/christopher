/**
 * The queue's dedupe rule, which lives in partial unique indexes: a key has at most one task that
 * is queued and has never started. A task already running does not absorb a new enqueue, so work
 * asked for while it runs gets one follow-up that reads the state as it is by then. CV builds are
 * the exception, one per draft whether queued or running.
 *
 * Requires a database: set TEST_DATABASE_URL (defaults to the local ava_test database).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { createDb } from "./client";
import { runMigrations } from "./migrate";
import { cvDrafts, tasks, users } from "./schema";
import { activeTaskFor, enqueueTask, enqueueTasks, taskRow } from "./tasks";

const { db, pool } = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test", { max: 1 });
beforeAll(() => runMigrations(db));
// Scans and HTML continuation generations carry task foreign keys. This disposable fixture owns
// no scan data, but Postgres still requires CASCADE when truncating a referenced parent table.
beforeEach(() => db.execute(sql`truncate tasks cascade`));
afterAll(() => pool.end());

const key = "review_library:00000000-0000-4000-8000-000000000001";
const review = () => enqueueTask(db, "review_library", { userId: "00000000-0000-4000-8000-000000000001" }, { dedupeKey: key });
/** What the queue's claim does to a row. */
const claim = (id: string) => db.update(tasks).set({ status: "running", startedAt: new Date(), attempts: sql`${tasks.attempts} + 1` }).where(eq(tasks.id, id));
const rows = () => db.select({ id: tasks.id, status: tasks.status }).from(tasks).orderBy(tasks.createdAt);

describe("a CV build's payload", () => {
  it("names the draft's owner, found by the draft's primary key", async () => {
    await db.execute(sql`truncate users restart identity cascade`);
    const [user] = await db.insert(users).values({ email: "payload-owner@example.com" }).returning();
    const [draft] = await db.insert(cvDrafts).values({
      userId: user!.id, jobTitle: "Role", companyName: "Co", jobDescription: "Lead.", libraryVersion: 1, librarySnapshot: {} as never, model: "test-model",
    }).returning();
    const id = await enqueueTask(db, "generate_cv", { draftId: draft!.id });
    const [row] = await db.select({ payload: tasks.payload }).from(tasks).where(eq(tasks.id, id!));
    expect(row!.payload).toEqual({ draftId: draft!.id, userId: user!.id });

    // The owner is looked up by `id = $1::uuid`, which the primary key answers, not by casting
    // every draft's id to text.
    let sent: SQL | undefined;
    const capture = { insert: () => ({ values: (value: Array<{ payload: SQL }>) => { sent = value[0]!.payload; return { onConflictDoNothing: () => ({ returning: async () => [] }) }; } }) };
    await enqueueTask(capture as never, "generate_cv", { draftId: draft!.id });
    const text = new PgDialect().sqlToQuery(sent!).sql;
    expect(text).toMatch(/where id = \$\d+::uuid/);
    expect(text).not.toMatch(/where id::text/);

    // An id that is not a uuid names no draft: the payload goes as it was, without an error.
    expect(await enqueueTask(db, "generate_cv", { draftId: "not-a-uuid" }, { dedupeKey: "generate_cv:not-a-uuid" })).toBeTruthy();
  });
});

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
      // Statistics after the fixture load, not whatever an earlier suite left behind.
      await tx.execute(sql`analyze tasks`);
      await tx.execute(sql`set local enable_seqscan = off`);
      return (await tx.execute(sql`explain select * from tasks where dedupe_key = ${key} and status in ('queued', 'running') limit 1`)).rows;
    });
    expect(JSON.stringify(plan)).toContain("tasks_dedupe_active_idx");
  });
});

describe("forced profile synthesis", () => {
  const userId = "00000000-0000-4000-8000-000000000003";
  const profileKey = `synthesize_profile:${userId}`;
  const profile = (force: boolean, options: { priority?: number; runAfter?: Date; promote?: boolean } = {}) =>
    enqueueTask(db, "synthesize_profile", { userId, force }, { dedupeKey: profileKey, ...options });
  const queued = async () => (await db.select().from(tasks).where(eq(tasks.dedupeKey, profileKey)))[0]!;

  it("upgrades a queued row without changing its time or priority, and does not downgrade it", async () => {
    const later = new Date(Date.now() + 3600_000);
    const id = await profile(false, { priority: 6, runAfter: later });
    expect(await profile(true, { priority: 1 })).toBeNull();
    expect(await queued()).toMatchObject({ id, payload: { userId, force: true }, priority: 6, runAfter: later });
    expect(await profile(false, { priority: 0 })).toBeNull();
    expect(await profile(true, { priority: 0 })).toBeNull();
    expect(await queued()).toMatchObject({ id, payload: { userId, force: true }, priority: 6, runAfter: later });

    await claim(id!);
    const followUp = await profile(true);
    expect(followUp).toBeTruthy();
    expect(followUp).not.toBe(id);
    expect((await db.select().from(tasks).where(eq(tasks.id, id!)))[0]!.payload).toEqual({ userId, force: true });
  });

  it.each([
    ["normal first", 250], ["forced first", 250], ["normal first", 1], ["forced first", 1],
  ] as const)("keeps the first row's scheduling and force in a non-promoted batch: %s, chunk %i", async (order, chunkSize) => {
    const later = new Date(Date.now() + 3600_000);
    const earlier = new Date(Date.now() + 1800_000);
    const normal = taskRow("synthesize_profile", { userId, force: false }, { priority: 6, runAfter: later });
    const forced = taskRow("synthesize_profile", { userId, force: true }, { priority: 1, runAfter: earlier });
    const batch = order === "normal first" ? [normal, forced, forced] : [forced, normal, forced];
    expect(await enqueueTasks(db, batch, chunkSize)).toBe(1);
    expect(await queued()).toMatchObject({
      payload: { userId, force: true },
      priority: order === "normal first" ? 6 : 1,
      runAfter: order === "normal first" ? later : earlier,
    });
    expect(await enqueueTasks(db, [normal])).toBe(0);
    expect((await queued()).payload).toEqual({ userId, force: true });
  });

  it("upgrades an existing queued row through the batched path without promoting it", async () => {
    const later = new Date(Date.now() + 3600_000);
    const id = await profile(false, { priority: 6, runAfter: later });
    expect(await enqueueTasks(db, [taskRow("synthesize_profile", { userId, force: true }, { priority: 1 })])).toBe(0);
    expect(await queued()).toMatchObject({ id, payload: { userId, force: true }, priority: 6, runAfter: later });
  });

  it("upgrades force in the promotion path even when priority and start time do not improve", async () => {
    const later = new Date(Date.now() + 3600_000);
    const id = await profile(false, { priority: 6, runAfter: later });
    expect(await profile(true, { priority: 6, runAfter: later, promote: true })).toBeNull();
    expect(await queued()).toMatchObject({ id, payload: { userId, force: true }, priority: 6, runAfter: later });
  });

  it.each(["normal first", "forced first"])("carries force through priority selection in a promoted batch: %s", async order => {
    const id = await profile(false, { priority: 6 });
    const normal = taskRow("synthesize_profile", { userId, force: false }, { priority: 1 });
    const forced = taskRow("synthesize_profile", { userId, force: true }, { priority: 4 });
    expect(await enqueueTasks(db, order === "normal first" ? [normal, forced] : [forced, normal], 250, true)).toBe(0);
    expect(await queued()).toMatchObject({ id, payload: { userId, force: true }, priority: 1 });
    expect(await profile(false, { priority: 0, promote: true })).toBeNull();
    expect(await queued()).toMatchObject({ id, payload: { userId, force: true }, priority: 0 });
  });
});
