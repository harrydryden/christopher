/** What a boot does before it claims anything: once per change, and in one statement. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, enqueueTask, listUserIds, schema, SEED_TAGS, type Db } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { AGEING_PRIORITY_FLOOR, dedupeKeyFor, DEFAULT_SYSTEM_SETTINGS, GATE_REEVALUATION_VERSION, priorityFor } from "@col/core";
import { and, eq, sql } from "drizzle-orm";
import { configuredModels, enqueueBootGateReevaluation, GATE_REEVALUATION_KEY, probeConfiguredModels, seedTagVocabularies } from "./boot";
import { agePriorities, claimTask } from "./queue";
import { getInternal } from "./settings";
import { ensureTestUser } from "./test-users";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/col_test";
const { db, pool } = createDb(DATABASE_URL, { max: 4 });

beforeAll(async () => { await runMigrations(db as Db); });
afterAll(async () => { await pool.end(); });
beforeEach(async () => {
  await db.execute(sql`truncate tasks, settings restart identity cascade`);
  await ensureTestUser(db, "boot-one@example.com", "member");
  await ensureTestUser(db, "boot-two@example.com", "member");
});

const gateTasks = () => db.select().from(schema.tasks).where(eq(schema.tasks.type, "reevaluate_gate"));

describe("gate re-evaluation on boot", () => {
  it("queues one background re-evaluation per account the first time a version is seen, and none after", async () => {
    const accounts = await listUserIds(db);
    expect(await enqueueBootGateReevaluation(db)).toBe(accounts.length);
    const queued = await gateTasks();
    expect(queued.map(t => (t.payload as { userId: string }).userId).sort()).toEqual([...accounts].sort());
    for (const task of queued) {
      expect(task.payload).toMatchObject({ reason: "boot" });
      expect(task.priority).toBe(7);
      expect(task.dedupeKey).toBe(`reevaluate_gate:${(task.payload as { userId: string }).userId}:boot`);
    }
    expect(await getInternal<number>(db as Db, GATE_REEVALUATION_KEY)).toBe(GATE_REEVALUATION_VERSION);

    // Every deploy and every crash-loop restart used to queue the whole set again.
    await db.update(schema.tasks).set({ status: "done" });
    expect(await enqueueBootGateReevaluation(db)).toBeNull();
    expect(await enqueueBootGateReevaluation(db)).toBeNull();
    expect(await gateTasks()).toHaveLength(accounts.length);

    // A release that changes what the gate means runs it once more.
    expect(await enqueueBootGateReevaluation(db, GATE_REEVALUATION_VERSION + 1)).toBe(accounts.length);
    expect(await getInternal<number>(db as Db, GATE_REEVALUATION_KEY)).toBe(GATE_REEVALUATION_VERSION + 1);
  });

  it("leaves accounts nobody has claimed alone", async () => {
    const [unclaimed] = await db.insert(schema.users).values({ email: `unclaimed-${Date.now()}@example.com` }).returning();
    try {
      await enqueueBootGateReevaluation(db);
      expect((await gateTasks()).some(t => (t.payload as { userId: string }).userId === unclaimed!.id)).toBe(false);
    } finally {
      await db.delete(schema.users).where(eq(schema.users.id, unclaimed!.id));
    }
  });

  it("queues one set when two pods boot at once", async () => {
    const accounts = await listUserIds(db);
    const results = await Promise.all([enqueueBootGateReevaluation(db), enqueueBootGateReevaluation(db)]);
    expect(results.filter(r => r === null)).toHaveLength(1);
    expect(await gateTasks()).toHaveLength(accounts.length);
  });

  it("never absorbs a person's own re-evaluation, and never lets the boot set jump ahead of it", async () => {
    const person = await ensureTestUser(db, "boot-one@example.com", "member");
    await enqueueBootGateReevaluation(db);
    // Saving a gate queues this, at the priority of work someone is waiting for.
    const payload = { userId: person.id };
    const own = await enqueueTask(db, "reevaluate_gate", payload, { dedupeKey: dedupeKeyFor("reevaluate_gate", payload), priority: priorityFor("reevaluate_gate") });
    expect(own).not.toBeNull();
    expect((await claimTask(db, "w#0", "interactive"))!.id).toBe(own);

    // However long the boot set waits, a CV build queued now still goes first.
    const hourAgo = new Date(Date.now() - 3600_000);
    await db.update(schema.tasks).set({ createdAt: hourAgo, runAfter: hourAgo }).where(and(eq(schema.tasks.type, "reevaluate_gate"), eq(schema.tasks.status, "queued")));
    for (let sweep = 0; sweep < 10; sweep++) await agePriorities(db);
    const boot = await db.select().from(schema.tasks).where(and(eq(schema.tasks.type, "reevaluate_gate"), eq(schema.tasks.status, "queued")));
    for (const task of boot) expect(task.priority).toBe(AGEING_PRIORITY_FLOOR + 1);
    const cv = await enqueueTask(db, "generate_cv", { draftId: "d" }, { priority: priorityFor("generate_cv") });
    expect((await claimTask(db, "w#0", "interactive"))!.id).toBe(cv);
  });
});

describe("seed vocabulary on boot", () => {
  it("gives every account the seed tags in one pass, and adds nothing the second time", async () => {
    const person = await ensureTestUser(db, "boot-two@example.com", "member");
    await db.delete(schema.tagVocabulary).where(eq(schema.tagVocabulary.userId, person.id));
    // A tag the model proposed and the person kept is theirs; seeding never touches it.
    await db.insert(schema.tagVocabulary).values({ userId: person.id, tag: "timing", description: "My own words", createdBy: "user" });

    expect(await seedTagVocabularies(db)).toBeGreaterThanOrEqual(SEED_TAGS.length - 1);
    const tags = await db.select().from(schema.tagVocabulary).where(eq(schema.tagVocabulary.userId, person.id));
    expect(tags.map(t => t.tag).sort()).toEqual(SEED_TAGS.map(t => t.tag).sort());
    expect(tags.find(t => t.tag === "timing")).toMatchObject({ description: "My own words", createdBy: "user" });

    expect(await seedTagVocabularies(db)).toBe(0);
  });
});

describe("model probe on boot", () => {
  it("asks about every configured model once, records a model_access event for each it cannot reach, and never throws", async () => {
    const [user] = await listUserIds(db);
    await db.execute(sql`truncate worker_events, user_settings`);
    await db.insert(schema.userSettings).values({ userId: user!, key: "cvModel", value: "claude-opus-5" })
      .onConflictDoUpdate({ target: [schema.userSettings.userId, schema.userSettings.key], set: { value: "claude-opus-5" } });
    const settings = { ...DEFAULT_SYSTEM_SETTINGS, modelOverrides: { A3: "claude-haiku-4-5" }, stageRoutes: { "cv.review": { model: "claude-sonnet-5" } } };
    expect(await configuredModels(db as Db, settings)).toEqual(["claude-fable-5-1", "claude-haiku-4-5", "claude-opus-5", "claude-sonnet-5"]);

    const asked: string[] = [];
    const ai = { probeModel: async (model: string) => {
      asked.push(model);
      return model === "claude-opus-5" ? { ok: false as const, message: "404 model: claude-opus-5", status: 404, failure: null } : { ok: true as const };
    } };
    expect(await probeConfiguredModels({ db: db as Db, ai, settings: async () => settings }, "boot-test")).toEqual(["claude-opus-5"]);
    expect(asked).toHaveLength(4);
    const events = await db.select().from(schema.workerEvents).where(eq(schema.workerEvents.kind, "model_access"));
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toMatchObject({ model: "claude-opus-5", status: 404, message: "404 model: claude-opus-5", source: "boot" });

    // A probe that cannot run at all reports nothing and does not stop the boot.
    const broken = { probeModel: async () => { throw new Error("offline"); } };
    expect(await probeConfiguredModels({ db: db as Db, ai: broken, settings: async () => settings }, "boot-test")).toEqual([]);
  });
});
