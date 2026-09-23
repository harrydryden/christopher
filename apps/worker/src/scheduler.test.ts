/** The scheduler's per-account fan-outs: bounded statements, whatever the number of accounts. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, enqueueTask, schema, type Db } from "@ava/db";
import { enqueueTasks } from "@ava/db/tasks";
import { runMigrations } from "@ava/db/migrate";
import { dedupeKeyFor } from "@ava/core";
import { and, eq, sql } from "drizzle-orm";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { claimTask, failTask } from "./queue";
import { schedulerTick } from "./scheduler";
import { ensureTestUser } from "./test-users";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test";

let deps: WorkerDeps;
let db: Db;
let now = new Date("2026-09-05T06:05:00Z");

beforeAll(async () => {
  const bootstrap = createDb(DATABASE_URL, { max: 1 });
  await runMigrations(bootstrap.db);
  await bootstrap.pool.end();
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.AVA_DISABLE_BROWSER = "1";
  deps = await createDeps(readEnv(), { now: () => now, settingsTtlMs: 0 });
  db = deps.db;
}, 60_000);
// Sources scheduled against this file's clock read as overdue to every later suite's real one.
afterAll(async () => {
  if (deps) await db.execute(sql`truncate discovery_sources cascade`);
  await deps?.close();
});
beforeEach(async () => {
  await db.execute(sql`truncate tasks, discovery_sources, settings restart identity cascade`);
  now = new Date("2026-09-05T06:05:00Z");
});

/** Each named account's own switch; `undefined` leaves no row, which is the default. */
async function accounts(switches: Array<unknown>) {
  const users = [];
  for (const [index, value] of switches.entries()) {
    const user = await ensureTestUser(db, `fan-out-${index}@example.com`, "member");
    await db.delete(schema.userSettings).where(and(eq(schema.userSettings.userId, user.id), eq(schema.userSettings.key, "suggestionsEnabled")));
    if (value !== undefined) await db.insert(schema.userSettings).values({ userId: user.id, key: "suggestionsEnabled", value: value as object });
    users.push(user);
  }
  return users;
}

const tasksOf = (type: schema.Task["type"]) => db.select().from(schema.tasks).where(eq(schema.tasks.type, type));

describe("weekly jobs", () => {
  async function weekly() {
    await db.insert(schema.settings).values([
      { key: "scanTime", value: "06:00" }, { key: "timezone", value: "UTC" }, { key: "weeklyDay", value: 0 },
    ]).onConflictDoNothing();
    deps.invalidateSettings();
    now = new Date("2026-09-06T07:30:00Z"); // a Sunday, an hour after the scan
    await schedulerTick(deps);
  }

  it("queues each account's jobs by its own switch, in one pass", async () => {
    // Off, on, and never set (the default is on); a malformed value falls back to the default as
    // the account's own settings do.
    const [off, on, unset, malformed] = await accounts([false, true, undefined, "no"]);
    await weekly();
    const byUser = async (type: schema.Task["type"]) =>
      (await tasksOf(type)).map(t => (t.payload as { userId: string }).userId);
    for (const user of [off, on, unset, malformed]) {
      expect(await byUser("suggest_filters")).toContain(user!.id);
      expect(await byUser("synthesize_profile")).toContain(user!.id);
    }
    const suggesting = await byUser("suggest_companies");
    expect(suggesting).not.toContain(off!.id);
    for (const user of [on, unset, malformed]) expect(suggesting).toContain(user!.id);
    const [profile] = (await tasksOf("synthesize_profile")).filter(t => (t.payload as { userId: string }).userId === on!.id);
    expect(profile!.payload).toEqual({ userId: on!.id, force: false });
    expect(profile!.dedupeKey).toBe(dedupeKeyFor("synthesize_profile", { userId: on!.id }));
  });

  it("reads every account's switch in the one statement, never account by account", async () => {
    await accounts([true, false, undefined]);
    const reads = vi.spyOn(deps, "userSettings");
    try {
      await weekly();
      expect(reads).not.toHaveBeenCalled();
      expect((await tasksOf("suggest_filters")).length).toBeGreaterThanOrEqual(3);
    } finally {
      reads.mockRestore();
    }
  });

  it("skips a job already queued for one account and still schedules everyone else's", async () => {
    const [first, second] = await accounts([true, true]);
    await enqueueTask(db, "suggest_filters", { userId: first!.id }, { dedupeKey: dedupeKeyFor("suggest_filters", { userId: first!.id }) });
    await weekly();
    const filters = (await tasksOf("suggest_filters")).map(t => (t.payload as { userId: string }).userId);
    expect(filters.filter(id => id === first!.id)).toHaveLength(1);
    expect(filters).toContain(second!.id);
  });
});

describe("batched enqueue", () => {
  it("inserts across statement boundaries and skips keys already queued or repeated in the batch", async () => {
    await enqueueTask(db, "discover", { companyId: "queued" }, { dedupeKey: "discover:queued" });
    const rows = ["a", "b", "queued", "c", "a"].map(companyId =>
      ({ type: "discover" as const, payload: { companyId }, dedupeKey: `discover:${companyId}` }));
    expect(await enqueueTasks(db, rows, 2)).toBe(3);
    const all = await db.select().from(schema.tasks);
    expect(all.map(t => t.dedupeKey).sort()).toEqual(["discover:a", "discover:b", "discover:c", "discover:queued"]);
    // The same defaults a single enqueue has.
    const [one] = all.filter(t => t.dedupeKey === "discover:a");
    expect(one).toMatchObject({ priority: 5, maxAttempts: 3, status: "queued", attempts: 0 });
  });
});

describe("promotion on a duplicate key", () => {
  const key = "score_job:account:role";
  const payload = { userId: "account", jobId: "role" };
  const theRow = async () => { const rows = await db.select().from(schema.tasks); expect(rows).toHaveLength(1); return rows[0]!; };

  it("brings a queued background row up to a person's request instead of absorbing it", async () => {
    const later = new Date(Date.now() + 3600_000);
    const queued = await enqueueTask(db, "score_job", payload, { dedupeKey: key, priority: 4, runAfter: later });
    // Without promotion the request is dropped, and waits at the background row's place.
    expect(await enqueueTask(db, "score_job", payload, { dedupeKey: key, priority: 1 })).toBeNull();
    expect((await theRow()).priority).toBe(4);
    // With it, the one row moves up, and is reported as not inserted.
    expect(await enqueueTask(db, "score_job", { ...payload, extra: "ignored" }, { dedupeKey: key, priority: 1, promote: true })).toBeNull();
    const row = await theRow();
    expect(row.id).toBe(queued);
    expect(row.priority).toBe(1);
    expect(row.runAfter.getTime()).toBeLessThan(later.getTime());
    expect(row.payload).toEqual(payload);
    // A less urgent request never demotes it.
    await enqueueTask(db, "score_job", payload, { dedupeKey: key, priority: 6, promote: true });
    expect((await theRow()).priority).toBe(1);
  });

  it("inserts when nothing is waiting, and leaves a running task alone", async () => {
    const id = await enqueueTask(db, "score_job", payload, { dedupeKey: key, priority: 4, promote: true });
    expect(id).not.toBeNull();
    await db.update(schema.tasks).set({ status: "running", startedAt: new Date() });
    // The running task keeps its place; the request becomes its one follow-up.
    const followUp = await enqueueTask(db, "score_job", payload, { dedupeKey: key, priority: 1, promote: true });
    expect(followUp).not.toBeNull();
    const rows = await db.select().from(schema.tasks);
    expect(rows.find(t => t.id === id)!.priority).toBe(4);
    expect(rows.find(t => t.id === followUp)!.priority).toBe(1);
    // A second request promotes that follow-up rather than adding another.
    expect(await enqueueTask(db, "score_job", payload, { dedupeKey: key, priority: 0, promote: true })).toBeNull();
    expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, followUp!)))[0]!.priority).toBe(0);
  });

  it("drops a duplicate CV build request rather than promoting it, whose key is held while it runs", async () => {
    const draftKey = "generate_cv:draft";
    const id = await enqueueTask(db, "generate_cv", { draftId: "draft" }, { dedupeKey: draftKey, priority: 2 });
    expect(await enqueueTask(db, "generate_cv", { draftId: "draft" }, { dedupeKey: draftKey, priority: 1, promote: true })).toBeNull();
    await db.update(schema.tasks).set({ status: "running", startedAt: new Date() });
    expect(await enqueueTask(db, "generate_cv", { draftId: "draft" }, { dedupeKey: draftKey, priority: 1, promote: true })).toBeNull();
    const [row] = await db.select().from(schema.tasks);
    expect(row!.id).toBe(id);
    expect(row!.priority).toBe(2);
  });

  it("promotes in a batch that names one key twice without failing the statement", async () => {
    await enqueueTask(db, "score_job", payload, { dedupeKey: key, priority: 4 });
    const rows = [5, 1, 3].map(priority => ({ type: "score_job" as const, payload, dedupeKey: key, priority }));
    expect(await enqueueTasks(db, [...rows, { type: "score_job" as const, payload: { userId: "account", jobId: "other" }, dedupeKey: "score_job:account:other", priority: 1 }], 250, true)).toBe(1);
    const all = await db.select().from(schema.tasks);
    expect(all.find(t => t.dedupeKey === key)!.priority).toBe(1);
    expect(all).toHaveLength(2);
  });
});

describe("company suggestion expiry", () => {
  it("expires month-old suggestions once an hour with the history maintenance, not on every tick", async () => {
    const [owner] = await accounts([true]);
    const suggest = async (name: string) => {
      const [row] = await db.insert(schema.companySuggestions).values({ userId: owner!.id, name, homepageUrl: `https://${name}.example`, domain: `${name}.example`,
        createdAt: new Date(now.getTime() - 31 * 86_400_000) }).returning();
      return row!.id;
    };
    const statusOf = async (id: string) => (await db.select().from(schema.companySuggestions).where(eq(schema.companySuggestions.id, id)))[0]!.status;
    const first = await suggest("first");
    await schedulerTick(deps);
    expect(await statusOf(first)).toBe("expired");
    const second = await suggest("second");
    await schedulerTick(deps);
    expect(await statusOf(second)).toBe("pending");
    await db.execute(sql`update settings set updated_at = now() - interval '2 hours' where key = 'internal:lastMaintenance'`);
    await schedulerTick(deps);
    expect(await statusOf(second)).toBe("expired");
    await db.delete(schema.companySuggestions).where(eq(schema.companySuggestions.userId, owner!.id));
  });
});

describe("discovery sources", () => {
  async function source(userId: string, name: string) {
    const [row] = await db.insert(schema.discoverySources).values({ userId, name, kind: "email", nextRunAt: now }).returning();
    return row!;
  }
  const nextRunOf = async (id: string) =>
    (await db.select().from(schema.discoverySources).where(eq(schema.discoverySources.id, id)))[0]!.nextRunAt.getTime();

  it("leases a due source a day ahead as it queues it, so a task that keeps failing is not queued every minute", async () => {
    const [owner] = await accounts([true]);
    const due = await source(owner!.id, "Newsletter");
    await schedulerTick(deps);
    expect(await tasksOf("monitor_source")).toHaveLength(1);
    expect(await nextRunOf(due.id)).toBe(now.getTime() + 86_400_000);

    // The run fails for good; the next ticks leave the source alone until its lease is up.
    const task = (await claimTask(db, "w", "background"))!;
    expect(await failTask(db, { ...task, maxAttempts: 1 }, new Error("timed out"))).toBe("failed");
    now = new Date(now.getTime() + 60_000);
    await schedulerTick(deps);
    now = new Date(now.getTime() + 60_000);
    await schedulerTick(deps);
    expect(await tasksOf("monitor_source")).toHaveLength(1);
  });

  it("looks again in an hour at a source whose owner has suggestions off, instead of every minute", async () => {
    const [off, on, unset] = await accounts([false, true, undefined]);
    const quiet = await source(off!.id, "Off");
    const loud = await source(on!.id, "On");
    const defaulted = await source(unset!.id, "Default");
    await schedulerTick(deps);
    const queued = (await tasksOf("monitor_source")).map(t => (t.payload as { sourceId: string }).sourceId).sort();
    expect(queued).toEqual([loud.id, defaulted.id].sort());
    expect(await nextRunOf(quiet.id)).toBe(now.getTime() + 3_600_000);

    // Switching suggestions back on is picked up within the hour, with no change anywhere else.
    await db.update(schema.userSettings).set({ value: true as unknown as object })
      .where(and(eq(schema.userSettings.userId, off!.id), eq(schema.userSettings.key, "suggestionsEnabled")));
    now = new Date(now.getTime() + 3_600_000);
    await schedulerTick(deps);
    expect((await tasksOf("monitor_source")).map(t => (t.payload as { sourceId: string }).sourceId)).toContain(quiet.id);
  });

  it("takes at most one batch of due sources a tick", async () => {
    const [owner] = await accounts([true]);
    await db.insert(schema.discoverySources).values(Array.from({ length: 205 }, (_, i) =>
      ({ userId: owner!.id, name: `Source ${i}`, kind: "email" as const, nextRunAt: new Date(now.getTime() - i * 1000) })));
    await schedulerTick(deps);
    expect(await tasksOf("monitor_source")).toHaveLength(200);
    // The longest overdue go first; the five most recently due wait for the next tick.
    const leftover = await db.select().from(schema.discoverySources).where(sql`${schema.discoverySources.nextRunAt} <= ${now}`);
    expect(leftover.map(s => s.name).sort()).toEqual(["Source 0", "Source 1", "Source 2", "Source 3", "Source 4"]);
  });
});
