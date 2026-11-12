import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { cvBuildFailure } from "@col/core";
import { createDb } from "./client";
import { runMigrations } from "./migrate";
import { acknowledgeCvActivity, getCvActivities } from "./cv-activity";
import { cvActivityEvents, cvBuildSteps, cvDrafts, tasks, users } from "./schema";

const { db, pool } = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/col_test", { max: 2 });
beforeAll(() => runMigrations(db));
afterAll(() => pool.end());

it("records only genuine AI completions and keeps read state private to the account", async () => {
  const ownerId = randomUUID();
  const otherId = randomUUID();
  await db.insert(users).values([
    { id: ownerId, email: `activity-${ownerId}@example.com` },
    { id: otherId, email: `activity-${otherId}@example.com` },
  ]);
  let taskId: string | undefined;
  try {
    const base = { userId: ownerId, companyName: "Acme", jobTitle: "Analyst", jobDescription: "Analyse work",
      libraryVersion: 1, librarySnapshot: {} as never };
    const [auto] = await db.insert(cvDrafts).values({ ...base, model: "test-model", editingMode: "auto" }).returning();
    const [manual] = await db.insert(cvDrafts).values({ ...base, model: "manual", editingMode: "manual" }).returning();
    const [task] = await db.insert(tasks).values({ type: "generate_cv", payload: { draftId: auto!.id, userId: ownerId } }).returning({ id: tasks.id });
    taskId = task!.id;
    await db.insert(cvBuildSteps).values({ draftId: auto!.id, userId: ownerId, attempt: 1,
      seq: 1, stage: "writing", motion: "write", title: "Writing", status: "running" });
    expect((await db.select().from(cvBuildSteps).where(eq(cvBuildSteps.draftId, auto!.id)))[0]?.stage).toBe("writing");
    const active = await getCvActivities(db, ownerId);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ id: `draft:${auto!.id}`, status: "queued", stage: "writing" });
    expect(active[0]!.work).toMatchObject({ progressAt: null, failure: null, error: null,
      task: { status: "queued", attempts: 0, maxAttempts: 3, error: null, startedAt: null } });

    await db.update(cvDrafts).set({ status: "ready" }).where(eq(cvDrafts.id, auto!.id));
    await db.update(cvDrafts).set({ status: "ready" }).where(eq(cvDrafts.id, manual!.id));
    await db.update(cvDrafts).set({ status: "ready" }).where(eq(cvDrafts.id, auto!.id));
    const events = await db.select().from(cvActivityEvents).where(eq(cvActivityEvents.userId, ownerId));
    expect(events).toHaveLength(1);
    const [completion] = await getCvActivities(db, ownerId);
    expect(completion).toMatchObject({ draftId: auto!.id, status: "ready", read: false, unread: true });
    expect(completion!.work).toBeUndefined();
    expect(await acknowledgeCvActivity(db, otherId, events[0]!.id)).toBe(false);
    expect(await acknowledgeCvActivity(db, ownerId, events[0]!.id)).toBe(true);
    expect(await acknowledgeCvActivity(db, ownerId, events[0]!.id)).toBe(true);
    expect(await getCvActivities(db, ownerId)).toEqual([]);
    expect((await db.select().from(cvActivityEvents).where(eq(cvActivityEvents.id, events[0]!.id)))[0]!.readAt).not.toBeNull();
    expect(await getCvActivities(db, otherId)).toEqual([]);

    const staleProgress = new Date(Date.now() - 15 * 60_000);
    const retryFailureRecord = cvBuildFailure("overloaded", "Provider overloaded", {
      resolvedBy: "system", attempt: 1, maxAttempts: 3, retryAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await db.update(cvDrafts).set({ status: "generating", progressAt: staleProgress,
      failure: retryFailureRecord, error: "Provider overloaded" }).where(eq(cvDrafts.id, auto!.id));
    await db.update(tasks).set({ status: "running", attempts: 1, startedAt: staleProgress }).where(eq(tasks.id, taskId!));
    await db.update(tasks).set({ status: "queued" }).where(eq(tasks.id, taskId!));
    const [retryTask] = await db.insert(tasks).values({ type: "generate_cv", payload: { draftId: auto!.id, userId: ownerId },
      attempts: 2, maxAttempts: 3, status: "running", startedAt: new Date() }).returning({ id: tasks.id });
    const retrying = await getCvActivities(db, ownerId);
    expect(retrying.map(item => item.status)).toEqual(["generating"]);
    expect(retrying[0]!.work).toMatchObject({ progressAt: staleProgress, failure: retryFailureRecord,
      error: "Provider overloaded", task: { status: "running", attempts: 2 } });
    await db.delete(tasks).where(eq(tasks.id, retryTask!.id));
    await db.update(cvDrafts).set({ status: "failed" }).where(eq(cvDrafts.id, auto!.id));
    const retryFailure = await getCvActivities(db, ownerId);
    expect(retryFailure).toHaveLength(1);
    expect(retryFailure[0]).toMatchObject({ status: "failed", unread: true });
    expect(retryFailure[0]!.id).not.toBe(events[0]!.id);
    await db.delete(cvDrafts).where(eq(cvDrafts.id, auto!.id));
    expect(await db.select().from(cvActivityEvents).where(eq(cvActivityEvents.draftId, auto!.id))).toEqual([]);
    expect(await getCvActivities(db, ownerId)).toEqual([]);
  } finally {
    if (taskId) await db.delete(tasks).where(eq(tasks.id, taskId));
    await db.delete(users).where(eq(users.id, ownerId));
    await db.delete(users).where(eq(users.id, otherId));
  }
});
