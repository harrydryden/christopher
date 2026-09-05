/** Queue and scheduler behaviour against a real database. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {createDb, enqueueTask, schema, type Db} from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { desc, eq, sql } from "drizzle-orm";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { backoffMs, claimTask, failTask, requeueStale, TaskQueue } from "./queue";
import { schedulerTick } from "./scheduler";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test";

let deps: WorkerDeps;
let db: Db;
let now = new Date("2026-09-05T06:05:00Z");

beforeAll(async () => {
  const bootstrap = createDb(DATABASE_URL, { max: 1 });
  await runMigrations(bootstrap.db);
  await bootstrap.pool.end();
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.CHRISTOPHER_DISABLE_BROWSER = "1";
  deps = await createDeps(readEnv(), { now: () => now, settingsTtlMs: 0 });
  db = deps.db;
}, 60_000);

afterAll(async () => {
  await deps?.close();
});

beforeEach(async () => {
  await db.execute(sql`truncate tasks, scan_runs, scans, companies, career_sources, jobs, settings restart identity cascade`);
  now = new Date("2026-09-05T06:05:00Z");
});

describe("task queue", () => {
  it("claims one task at a time, in priority then age order", async () => {
    await enqueueTask(db, "suggest_companies", {}, { priority: 7 });
    await enqueueTask(db, "discover", { companyId: "a" }, { priority: 1 });
    const first = await claimTask(db, "w1");
    expect(first!.type).toBe("discover");
    expect(first!.status).toBe("running");
    expect(first!.attempts).toBe(1);
    const second = await claimTask(db, "w1");
    expect(second!.type).toBe("suggest_companies");
    expect(await claimTask(db, "w1")).toBeNull();
  });

  it("does not hand the same task to two workers", async () => {
    await enqueueTask(db, "discover", { companyId: "a" }, {});
    const [a, b] = await Promise.all([claimTask(db, "w1"), claimTask(db, "w2")]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("refuses to queue a duplicate while one is queued or running", async () => {
    const first = await enqueueTask(db, "scan_company", { companyId: "a" }, { dedupeKey: "scan_company:a" });
    const second = await enqueueTask(db, "scan_company", { companyId: "a" }, { dedupeKey: "scan_company:a" });
    expect(first).toBeTruthy();
    expect(second).toBeNull();
    // Once it finishes, the same key can be queued again.
    await db.update(schema.tasks).set({ status: "done" }).where(eq(schema.tasks.id, first!));
    expect(await enqueueTask(db, "scan_company", { companyId: "a" }, { dedupeKey: "scan_company:a" })).toBeTruthy();
  });

  it("retries with a growing delay, then gives up", async () => {
    await enqueueTask(db, "discover", { companyId: "a" }, { maxAttempts: 2 });
    const first = await claimTask(db, "w1");
    expect(await failTask(db, first!, new Error("network"))).toBe("retry");
    const [afterRetry] = await db.select().from(schema.tasks);
    expect(afterRetry!.status).toBe("queued");
    expect(afterRetry!.runAfter.getTime()).toBeGreaterThan(Date.now());

    await db.update(schema.tasks).set({ runAfter: new Date(0) });
    const second = await claimTask(db, "w1");
    expect(await failTask(db, second!, new Error("network"))).toBe("failed");
    const [dead] = await db.select().from(schema.tasks);
    expect(dead!.status).toBe("failed");
    expect(dead!.error).toContain("network");
  });

  it("grows the backoff and caps it", () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(20)).toBe(30 * 60_000);
  });

  it("puts tasks abandoned by a crashed worker back on the queue", async () => {
    await enqueueTask(db, "discover", { companyId: "a" }, {});
    const task = await claimTask(db, "w1");
    await db.update(schema.tasks).set({ lockedAt: new Date(Date.now() - 60 * 60_000) }).where(eq(schema.tasks.id, task!.id));
    expect(await requeueStale(db)).toBe(1);
    const [requeued] = await db.select().from(schema.tasks);
    expect(requeued!.status).toBe("queued");
    expect(requeued!.error).toContain("stale");
  });

  it("records a handler's result and keeps going after one fails", async () => {
    const seen: string[] = [];
    const queue = new TaskQueue(
      deps,
      {
        discover: async (task) => {
          seen.push(task.id);
          throw new Error("handler exploded");
        },
        reevaluate_gate: async () => {
          seen.push("ok");
          return { done: true };
        },
      },
      { concurrency: 1, workerId: "test" },
    );
    await enqueueTask(db, "discover", { companyId: "a" }, { maxAttempts: 1 });
    await enqueueTask(db, "reevaluate_gate", {}, {});
    await queue.drain();
    expect(seen).toHaveLength(2);
    const rows = await db.select().from(schema.tasks).orderBy(schema.tasks.type);
    expect(rows.find((r) => r.type === "discover")!.status).toBe("failed");
    const ok = rows.find((r) => r.type === "reevaluate_gate")!;
    expect(ok.status).toBe("done");
    expect(ok.result).toEqual({ done: true });
  });

  it("fails a task with no handler rather than looping on it", async () => {
    const queue = new TaskQueue(deps, {}, { concurrency: 1, workerId: "test" });
    await enqueueTask(db, "discover", { companyId: "a" }, { maxAttempts: 1 });
    await queue.drain();
    const [row] = await db.select().from(schema.tasks);
    expect(row!.status).toBe("failed");
    expect(row!.error).toContain("no handler");
  });
});

describe("scheduler", () => {
  async function setSettings(values: Record<string, unknown>) {
    for (const [key, value] of Object.entries(values)) {
      await db.insert(schema.settings).values({ key, value: value as object }).onConflictDoUpdate({ target: schema.settings.key, set: { value: value as object } });
    }
    deps.invalidateSettings();
  }

  it("starts the daily run once the local time passes the scan time", async () => {
    await setSettings({ scanTime: "06:00", timezone: "UTC" });
    now = new Date("2026-09-05T05:55:00Z");
    await schedulerTick(deps);
    expect(await db.select().from(schema.tasks)).toHaveLength(0);

    now = new Date("2026-09-05T06:01:00Z");
    await schedulerTick(deps);
    const tasks = await db.select().from(schema.tasks);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.type).toBe("run_daily");
    expect(tasks[0]!.payload).toMatchObject({ trigger: "schedule", runDate: "2026-09-05" });
  });

  it("does not start a second run for the same day", async () => {
    await setSettings({ scanTime: "06:00", timezone: "UTC" });
    now = new Date("2026-09-05T06:01:00Z");
    await schedulerTick(deps);
    await db.insert(schema.scanRuns).values({ runDate: "2026-09-05", trigger: "schedule" });
    await db.update(schema.tasks).set({ status: "done" });
    await schedulerTick(deps);
    const runDaily = await db.select().from(schema.tasks).where(eq(schema.tasks.type, "run_daily"));
    expect(runDaily).toHaveLength(1);
  });

  it("respects the configured timezone", async () => {
    // 06:00 in Europe/London during British Summer Time is 05:00 UTC.
    await setSettings({ scanTime: "06:00", timezone: "Europe/London" });
    now = new Date("2026-09-05T04:30:00Z");
    await schedulerTick(deps);
    expect(await db.select().from(schema.tasks)).toHaveLength(0);
    now = new Date("2026-09-05T05:30:00Z");
    await schedulerTick(deps);
    expect((await db.select().from(schema.tasks)).some((t) => t.type === "run_daily")).toBe(true);
  });

  it("queues the weekly jobs once a week, an hour after the daily run", async () => {
    await setSettings({ scanTime: "06:00", timezone: "UTC", weeklyDay: 0, suggestionsEnabled: true });
    now = new Date("2026-09-06T07:30:00Z"); // a Sunday
    await schedulerTick(deps);
    const types = (await db.select().from(schema.tasks)).map((t) => t.type).sort();
    expect(types).toContain("suggest_filters");
    expect(types).toContain("synthesize_profile");
    expect(types).toContain("suggest_companies");

    await db.update(schema.tasks).set({ status: "done" });
    await schedulerTick(deps);
    const again = await db.select().from(schema.tasks).where(eq(schema.tasks.status, "queued"));
    expect(again.filter((t) => t.type === "suggest_filters")).toHaveLength(0);
  });

  it("leaves the weekly suggestion job out when suggestions are switched off", async () => {
    await setSettings({ scanTime: "06:00", timezone: "UTC", weeklyDay: 0, suggestionsEnabled: false });
    now = new Date("2026-09-06T07:30:00Z");
    await schedulerTick(deps);
    const types = (await db.select().from(schema.tasks)).map((t) => t.type);
    expect(types).not.toContain("suggest_companies");
    expect(types).toContain("suggest_filters");
  });
});
