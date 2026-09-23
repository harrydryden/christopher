/** Queue and scheduler behaviour against a real database. */
import { renewTask, completeTask, assertTaskOwnership } from "./queue";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {createDb, enqueueTask, listUserIds, listWorkerEvents, schema, setSubscriptionStatus, subscribeToCompany, type Db} from "@ava/db";
import { AGEING_PRIORITY_FLOOR, dedupeKeyFor, isUserSettingsKey, priorityFor } from "@ava/core";
import { ensureTestUser } from "./test-users";
import { runMigrations } from "@ava/db/migrate";
import { desc, eq, sql } from "drizzle-orm";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { agePriorities, assertRunOwnership, backoffMs, BUSY_REFUND_WINDOW_MS, claimTask, deadlineMsFor, failSpentTasks, failTask, laneSlots, recoverFromCrash, requeueStale, ShutdownError, sleep, TASK_STALE_AFTER_MS, TaskQueue } from "./queue";
import { LeaseBusyError, withResourceLease, type RunDeps } from "./lease";
import { reconcileCvDrafts, schedulerTick, startScheduler } from "./scheduler";
import { CV_ABANDONED_MESSAGE, onAbandon, onInterrupted } from "./handlers";

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

/** A queue a test started; stopped after the test so a failure cannot leave loops polling. */
let queueUnderTest: TaskQueue | null = null;

afterAll(async () => {
  await deps?.close();
});

afterEach(async () => {
  await queueUnderTest?.stop(1000);
  queueUnderTest = null;
});

beforeEach(async () => {
  await db.execute(sql`truncate tasks, scan_runs, scans, companies, career_sources, jobs, settings, user_settings restart identity cascade`);
  now = new Date("2026-09-05T06:05:00Z");
});

describe("task queue", () => {
  it("serialises concurrent migrations without leaking session locks", async () => {
    const client = createDb(DATABASE_URL, { max: 3 });
    try {
      await Promise.all([runMigrations(client.db), runMigrations(client.db)]);
      const locks = await client.db.execute(sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = 74233101`);
      expect(locks.rows[0]!.n).toBe(0);
    } finally {
      await client.pool.end();
    }
  }, 30_000);

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

  it("puts tasks abandoned by a crashed worker back on the queue, with an attempt spent and a backoff", async () => {
    await enqueueTask(db, "discover", { companyId: "a" }, {});
    const task = await claimTask(db, "w1");
    await db.update(schema.tasks).set({ lockedAt: new Date(Date.now() - 60 * 60_000) }).where(eq(schema.tasks.id, task!.id));
    expect(await requeueStale(db)).toEqual({ requeued: 1, failed: 0 });
    const [requeued] = await db.select().from(schema.tasks);
    expect(requeued!.status).toBe("queued");
    expect(requeued!.error).toContain("worker lost while running (attempt 1 of 3)");
    // The next attempt waits: a worker that died on this task should not be handed it instantly.
    expect(requeued!.runAfter.getTime()).toBeGreaterThan(Date.now());
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
  // The weekly jobs are queued per account, so there has to be one.
  beforeEach(async () => { await ensureTestUser(db, "scheduler@example.com"); });

  /**
   * Each key to the table that owns it. `settings` is the administrator's, and a key that belongs
   * to an account is only ever read from that account's own rows, so one written into the shared
   * table would simply be ignored.
   */
  async function setSettings(values: Record<string, unknown>) {
    const userIds = await listUserIds(db);
    for (const [key, value] of Object.entries(values)) {
      if (isUserSettingsKey(key)) {
        for (const userId of userIds) {
          await db.insert(schema.userSettings).values({ userId, key, value: value as object })
            .onConflictDoUpdate({ target: [schema.userSettings.userId, schema.userSettings.key], set: { value: value as object } });
        }
        continue;
      }
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

  it("ages the queue one step a minute however many ticks run in it", async () => {
    // Every worker and the cron fallback tick; ageing is claimed once for all of them.
    const id = await enqueueTask(db, "suggest_filters", { userId: "aged" }, { priority: 6 });
    const hourAgo = new Date(Date.now() - 3600_000);
    await db.update(schema.tasks).set({ createdAt: hourAgo, runAfter: hourAgo }).where(eq(schema.tasks.id, id!));
    await schedulerTick(deps);
    await schedulerTick(deps);
    expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, id!)))[0]!.priority).toBe(5);
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

it("fences completion, failure and writes from a reclaimed attempt", async () => {
  await enqueueTask(db, "discover", { companyId: "a" });
  const old = (await claimTask(db, "same-worker"))!;
  await db.update(schema.tasks).set({ lockedAt: new Date(0) });
  await requeueStale(db);
  await db.update(schema.tasks).set({ runAfter: sql`now()` }); // past the recovery backoff
  const current = (await claimTask(db, "same-worker"))!;
  expect(await renewTask(db, old)).toBe(false);
  await completeTask(db, old, { stale: true });
  await failTask(db, old, new Error("stale"));
  await expect(assertTaskOwnership(db, old)).rejects.toThrow("lease lost");
  expect((await db.select().from(schema.tasks))[0]!.status).toBe("running");
  await completeTask(db, current, { current: true });
  expect((await db.select().from(schema.tasks))[0]!.result).toEqual({ current: true });
});
it("renews a live task lease and isolates queue lanes", async () => {
  await enqueueTask(db, "discover", { companyId: "a" });
  await enqueueTask(db, "scan_company", { companyId: "b" });
  await enqueueTask(db, "suggest_companies", {});
  expect((await claimTask(db, "scan", "scan"))!.type).toBe("scan_company");
  expect((await claimTask(db, "background", "background"))!.type).toBe("suggest_companies");
  const task = (await claimTask(db, "interactive", "interactive"))!;
  await db.update(schema.tasks).set({ lockedAt: new Date(0) }).where(eq(schema.tasks.id, task.id));
  expect(await renewTask(db, task)).toBe(true);
  expect(await requeueStale(db)).toEqual({ requeued: 0, failed: 0 });
});

it("recovers a stopped worker after five missed minutes while retaining a fresh long-running task", async () => {
  await enqueueTask(db, "generate_cv", { draftId: "stopped" });
  await enqueueTask(db, "generate_cv", { draftId: "live" });
  const stopped = (await claimTask(db, "retiring-worker"))!;
  const live = (await claimTask(db, "current-worker"))!;
  await db.update(schema.tasks).set({ lockedAt: new Date(Date.now() - 6 * 60_000) }).where(eq(schema.tasks.id, stopped.id));
  await db.update(schema.tasks).set({ startedAt: new Date(Date.now() - 30 * 60_000), lockedAt: new Date(Date.now() - 60_000) }).where(eq(schema.tasks.id, live.id));
  expect(await requeueStale(db)).toEqual({ requeued: 1, failed: 0 });
  await db.update(schema.tasks).set({ runAfter: sql`now()` }).where(eq(schema.tasks.id, stopped.id));
  const recovered = (await claimTask(db, "current-worker"))!;
  expect(recovered.id).toBe(stopped.id);
  expect(recovered.attempts).toBe(stopped.attempts + 1);
  expect(await renewTask(db, stopped)).toBe(false);
  expect(await renewTask(db, live)).toBe(true);
  await expect(assertTaskOwnership(db, stopped)).rejects.toThrow("lease lost");
});

it("fans out one scan per company with an active follower, and none for a company everyone paused", async () => {
  const { handleRunDaily } = await import("./handlers/daily");
  const one = await ensureTestUser(db, "follower-one@example.com");
  const two = await ensureTestUser(db, "follower-two@example.com", "member");
  const board = async (name: string) => {
    const [company] = await db.insert(schema.companies).values({ name, domain: `${name}.example`, homepageUrl: `https://${name}.example` }).returning();
    await db.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: `https://${name}.example/jobs`, status: "active" });
    return company!;
  };
  const shared = await board("shared");
  const rested = await board("rested");
  // Two people follow the first company; both have paused the second.
  for (const userId of [one.id, two.id]) {
    await subscribeToCompany(db, userId, shared.id);
    await subscribeToCompany(db, userId, rested.id);
    await setSubscriptionStatus(db, userId, rested.id, "paused");
  }

  await enqueueTask(db, "run_daily", { trigger: "schedule", runDate: "2026-09-05" }, { dedupeKey: "run_daily", priority: 5 });
  const task = (await claimTask(db, "worker", "scan"))!;
  await handleRunDaily(task, deps);

  const fanned = await db.select().from(schema.tasks).where(eq(schema.tasks.type, "scan_company"));
  expect(fanned).toHaveLength(1);
  expect(fanned[0]!.payload).toMatchObject({ companyId: shared.id, trigger: "schedule" });
  const [run] = await db.select().from(schema.scanRuns);
  expect(run!.companiesTotal).toBe(1);

  // Running the same day's fan-out again adds neither a run nor a second scan of that company.
  await handleRunDaily({ ...task, result: null } as typeof task, deps);
  expect(await db.select().from(schema.scanRuns)).toHaveLength(1);
  expect(await db.select().from(schema.tasks).where(eq(schema.tasks.type, "scan_company"))).toHaveLength(1);
});

it("does not repeat a manual daily fan-out after a crash between commit and completion", async () => {
  const { handleRunDaily } = await import("./handlers/daily");
  await db.insert(schema.companies).values({ name: "Test", domain: "test.example", homepageUrl: "https://test.example" });
  await enqueueTask(db, "run_daily", { trigger: "manual" }, { priority: 1 });
  const first = (await claimTask(db, "first"))!;
  await handleRunDaily(first, deps);
  await db.update(schema.tasks).set({ lockedAt: new Date(0) }).where(eq(schema.tasks.id, first.id));
  await requeueStale(db);
  await db.update(schema.tasks).set({ runAfter: sql`now()` }).where(eq(schema.tasks.id, first.id));
  const retry = (await claimTask(db, "second", "scan"))!;
  expect(retry.id).toBe(first.id);
  await handleRunDaily(retry, deps);
  expect(await db.select().from(schema.scanRuns)).toHaveLength(1);
  expect(await db.select().from(schema.tasks).where(eq(schema.tasks.type, "scan_company"))).toHaveLength(1);
});

describe("execution model", () => {
  it("gives every lane a slot and divides the rest in proportion", () => {
    // Below three slots a slot rotates lanes instead of owning one.
    expect(laneSlots(1)).toBeNull();
    expect(laneSlots(2)).toBeNull();
    expect(laneSlots(3)).toEqual(["interactive", "scan", "background"]);
    // The deployed size: half the slots to what someone is waiting for, then the daily scan.
    expect(laneSlots(6)).toEqual(["interactive", "interactive", "interactive", "scan", "scan", "background"]);
    for (const n of [3, 4, 5, 6, 7, 10, 30]) {
      const slots = laneSlots(n)!;
      expect(slots).toHaveLength(n);
      for (const lane of ["interactive", "scan", "background"]) expect(slots.filter(s => s === lane).length).toBeGreaterThanOrEqual(1);
    }
  });

  it("lets every slot fall through to the rest of the queue when its own lane is empty", async () => {
    // Three CV builds and three slots. Pinned to one lane each, only the interactive slot could
    // take them and they would run one at a time; falling through, all three run at once.
    let running = 0;
    let release!: () => void;
    const started = new Promise<void>(resolve => { release = resolve; });
    const all = new Promise<void>(resolve => {
      const handler = async () => { if (++running === 3) resolve(); await started; return { ok: true }; };
      queueUnderTest = new TaskQueue(deps, { generate_cv: handler }, { concurrency: 3, workerId: "fallthrough", pollMs: 10 });
    });
    for (const draftId of ["a", "b", "c"]) await enqueueTask(db, "generate_cv", { draftId });
    queueUnderTest!.start();
    await Promise.race([all, new Promise((_, reject) => setTimeout(() => reject(new Error("only one lane served the queue")), 10_000))]);
    expect(running).toBe(3);
    release();
    await queueUnderTest!.stop(5_000);
  }, 20_000);

  it("serialises company verification without occupying the other queue slots", async () => {
    let verifying = 0;
    let maxVerifying = 0;
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve; });
    let firstStarted!: () => void;
    const sawFirst = new Promise<void>(resolve => { firstStarted = resolve; });
    let otherStarted!: () => void;
    const sawOther = new Promise<void>(resolve => { otherStarted = resolve; });
    let bothVerified!: () => void;
    const sawBoth = new Promise<void>(resolve => { bothVerified = resolve; });
    let completed = 0;

    queueUnderTest = new TaskQueue(deps, {
      verify_company: async () => {
        verifying++;
        maxVerifying = Math.max(maxVerifying, verifying);
        if (completed === 0) { firstStarted(); await firstBlocked; }
        verifying--;
        if (++completed === 2) bothVerified();
        return {};
      },
      reevaluate_gate: async () => { otherStarted(); return {}; },
    }, { concurrency: 3, workerId: "bounded-verification", pollMs: 10 });

    await enqueueTask(db, "verify_company", { candidateId: "one" });
    await enqueueTask(db, "verify_company", { candidateId: "two" });
    await enqueueTask(db, "reevaluate_gate", { userId: "account" });
    queueUnderTest.start();

    await Promise.race([Promise.all([sawFirst, sawOther]), new Promise((_, reject) => setTimeout(() => reject(new Error("eligible work was starved")), 5_000))]);
    expect(verifying).toBe(1);
    const running = await db.select().from(schema.tasks).where(eq(schema.tasks.status, "running"));
    expect(running.filter(task => task.type === "verify_company")).toHaveLength(1);
    releaseFirst();
    await Promise.race([sawBoth, new Promise((_, reject) => setTimeout(() => reject(new Error("second verification did not run")), 5_000))]);
    expect(maxVerifying).toBe(1);
    await queueUnderTest.stop(5_000);
  }, 15_000);

  it("lets CV builds take at most their share of the slots, so other work still runs beside a backlog of them", async () => {
    let building = 0;
    let maxBuilding = 0;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let discovered!: () => void;
    const sawDiscover = new Promise<void>(resolve => { discovered = resolve; });
    queueUnderTest = new TaskQueue(deps, {
      generate_cv: async () => {
        building++;
        maxBuilding = Math.max(maxBuilding, building);
        await held;
        building--;
        return {};
      },
      discover: async () => { discovered(); return {}; },
    }, { concurrency: 3, workerId: "capped-builds", pollMs: 10, maxActiveByType: { generate_cv: 2 } });
    for (const draftId of ["a", "b", "c", "d", "e"]) await enqueueTask(db, "generate_cv", { draftId }, { priority: 2 });
    queueUnderTest.start();
    while (building < 2) await sleep(10);
    // Queued behind five builds, at a less urgent priority than any of them, it still runs.
    await enqueueTask(db, "discover", { companyId: "behind-the-builds" }, { priority: 6 });
    await Promise.race([sawDiscover, new Promise((_, reject) => setTimeout(() => reject(new Error("the builds held every slot")), 5_000))]);
    await sleep(100);
    expect(maxBuilding).toBe(2);
    const running = await db.select().from(schema.tasks).where(eq(schema.tasks.status, "running"));
    expect(running.filter(task => task.type === "generate_cv")).toHaveLength(2);
    release();
    await queueUnderTest.stop(5_000);
  }, 15_000);

  it("releases the verification slot after a handler fails", async () => {
    let calls = 0;
    let secondStarted!: () => void;
    const sawSecond = new Promise<void>(resolve => { secondStarted = resolve; });
    queueUnderTest = new TaskQueue(deps, {
      verify_company: async () => {
        if (++calls === 1) throw new Error("first verification failed");
        secondStarted();
        return {};
      },
    }, { concurrency: 3, workerId: "failed-verification", pollMs: 10 });
    await enqueueTask(db, "verify_company", { candidateId: "one" }, { maxAttempts: 1 });
    await enqueueTask(db, "verify_company", { candidateId: "two" }, { maxAttempts: 1 });
    queueUnderTest.start();
    await Promise.race([sawSecond, new Promise((_, reject) => setTimeout(() => reject(new Error("verification slot stayed reserved")), 5_000))]);
    expect(calls).toBe(2);
    await queueUnderTest.stop(5_000);
  }, 15_000);

  it("keeps verification reserved while a timed-out handler is still unwinding", async () => {
    let calls = 0;
    let releaseTimedOut!: () => void;
    const ignoredAbort = new Promise<void>(resolve => { releaseTimedOut = resolve; });
    let otherStarted!: () => void;
    const sawOther = new Promise<void>(resolve => { otherStarted = resolve; });
    let secondStarted!: () => void;
    const sawSecond = new Promise<void>(resolve => { secondStarted = resolve; });
    queueUnderTest = new TaskQueue(deps, {
      verify_company: async () => {
        if (++calls === 1) { await ignoredAbort; return {}; }
        secondStarted();
        return {};
      },
      reevaluate_gate: async () => { otherStarted(); return {}; },
    }, { concurrency: 3, workerId: "timed-out-verification", pollMs: 10, deadlines: { verify_company: 30 } });
    await enqueueTask(db, "verify_company", { candidateId: "one" }, { maxAttempts: 1 });
    await enqueueTask(db, "verify_company", { candidateId: "two" }, { maxAttempts: 1 });
    await enqueueTask(db, "reevaluate_gate", { userId: "account" });
    queueUnderTest.start();
    await Promise.race([sawOther, new Promise((_, reject) => setTimeout(() => reject(new Error("other work was starved")), 5_000))]);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(calls).toBe(1);
    releaseTimedOut();
    await Promise.race([sawSecond, new Promise((_, reject) => setTimeout(() => reject(new Error("verification slot was not released after settlement")), 5_000))]);
    expect(calls).toBe(2);
    await queueUnderTest.stop(5_000);
  }, 15_000);

  it("fails a handler that outruns its deadline, naming the type and the time it took", async () => {
    let release!: () => void;
    const hang = new Promise<void>(resolve => { release = resolve; });
    const queue = new TaskQueue(deps, { discover: () => hang.then(() => ({})) },
      { concurrency: 1, workerId: "deadline", deadlines: { default: 60 } });
    await enqueueTask(db, "discover", { companyId: "a" }, { maxAttempts: 1 });
    await queue.drain();
    const [row] = await db.select().from(schema.tasks);
    expect(row!.status).toBe("failed");
    expect(row!.error).toContain("TimeoutError: discover exceeded its 0s deadline");
    // The abandoned handler is still running; the queue has moved on rather than waiting on it.
    release();
    await hang;
  });

  it("uses the per-type deadline table, and a caller's override before it", () => {
    expect(deadlineMsFor("scan_company")).toBe(3 * 60_000);
    expect(deadlineMsFor("generate_cv")).toBe(45 * 60_000);
    expect(deadlineMsFor("discover")).toBe(5 * 60_000);
    expect(deadlineMsFor("score_job")).toBe(2 * 60_000);
    expect(deadlineMsFor("scan_company", { scan_company: 5 })).toBe(5);
    expect(deadlineMsFor("score_job", { default: 5 })).toBe(5);
  });

  it("hands back its tasks and releases its own AI holds when it stops", async () => {
    const user = await ensureTestUser(db, "shutdown@example.com");
    await db.execute(sql`delete from ai_reservations`);
    await db.execute(sql`insert into ai_reservations (user_id, call_site, amount, expires_at, worker_id)
      values (${user.id}, 'CV', 1, now() + interval '30 minutes', 'retiring'),
             (${user.id}, 'CV', 1, now() + interval '30 minutes', 'another-worker')`);

    let seen!: () => void;
    const claimed = new Promise<void>(resolve => { seen = resolve; });
    let release!: () => void;
    const hang = new Promise<void>(resolve => { release = resolve; });
    const queue = new TaskQueue(deps, { generate_cv: async () => { seen(); await hang; return {}; } },
      { concurrency: 1, workerId: "retiring", pollMs: 10 });
    await enqueueTask(db, "generate_cv", { draftId: "interrupted" });
    queue.start();
    await claimed;

    // The handler is still running when the cap fires: its task goes straight back on the queue
    // rather than waiting out the five-minute stale lock, and keeps its attempt.
    await queue.stop(50);
    const [row] = await db.select().from(schema.tasks);
    expect(row!.status).toBe("queued");
    expect(row!.attempts).toBe(0);
    expect(row!.lockedBy).toBeNull();
    expect(row!.error).toContain("shutting down");
    const holds = await db.execute<{ workerId: string }>(sql`select worker_id as "workerId" from ai_reservations`);
    expect(holds.rows.map(r => r.workerId)).toEqual(["another-worker"]);
    release();
    await hang;
    await db.execute(sql`delete from ai_reservations`);
  }, 20_000);
});

describe("stopping", () => {
  beforeEach(async () => { await db.execute(sql`truncate worker_events, ai_reservations`); });
  const theTask = async () => (await db.select().from(schema.tasks))[0]!;
  const holdsFor = async (workerId: string) =>
    Number((await db.execute<{ n: number }>(sql`select count(*)::int as n from ai_reservations where worker_id = ${workerId}`)).rows[0]!.n);

  it("stops every run as it begins, and hands its task back whatever the handler did on the way out", async () => {
    // A CV build on its last attempt reads the abort as a failure and writes the draft failed, then
    // returns normally. Aborting before handing back used to let that write through the fence and
    // mark the task done: every deploy would have failed someone's CV for good.
    let reason: unknown;
    let write: string | undefined;
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const queue = new TaskQueue(deps, {
      generate_cv: async (_task, runDeps, ctx) => {
        started();
        await new Promise(resolve => ctx.signal.addEventListener("abort", resolve, { once: true }));
        reason = ctx.signal.reason;
        write = await db.transaction(async tx => runDeps.assertOwnership!(tx as unknown as Db)).then(() => "written", (e: Error) => e.message);
        return { failed: true };
      },
    }, { concurrency: 1, workerId: "deploying", pollMs: 10 });
    await enqueueTask(db, "generate_cv", { draftId: "last-attempt" }, { maxAttempts: 1 });
    queue.start();
    await running;
    const began = Date.now();
    await queue.stop(5_000);
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(reason).toBeInstanceOf(ShutdownError);
    expect(write).toBe("Run was stopped; refusing its writes");
    const row = await theTask();
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(0);
    expect(row.error).toContain("shutting down");
    expect(await listWorkerEvents(db, { kinds: ["task_abandoned"] })).toHaveLength(0);
  }, 15_000);

  it("hands the rows back before the grace, and releases the holds only once the stopped runs settle", async () => {
    const user = await ensureTestUser(db, "stopping@example.com");
    await db.execute(sql`insert into ai_reservations (user_id, call_site, amount, expires_at, worker_id)
      values (${user.id}, 'CV', 1, now() + interval '30 minutes', 'settling')`);
    let statusDuringGrace: string | undefined;
    let holdsDuringGrace: number | undefined;
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const queue = new TaskQueue(deps, {
      generate_cv: async (_task, _deps, ctx) => {
        started();
        await new Promise(resolve => ctx.signal.addEventListener("abort", resolve, { once: true }));
        // The run is still closing its streams: its task is already safe, its hold not yet gone.
        await sleep(200);
        statusDuringGrace = (await theTask()).status;
        holdsDuringGrace = await holdsFor("settling");
        throw ctx.signal.reason;
      },
    }, { concurrency: 1, workerId: "settling", pollMs: 10 });
    await enqueueTask(db, "generate_cv", { draftId: "settling" });
    queue.start();
    await running;
    await queue.stop(5_000);
    expect(statusDuringGrace).toBe("queued");
    expect(holdsDuringGrace).toBe(1);
    expect(await holdsFor("settling")).toBe(0);
    expect((await theTask()).attempts).toBe(0);
  }, 15_000);

  it("puts back what it held after an uncaught exception, spending the attempt as a crash does", async () => {
    const user = await ensureTestUser(db, "crashing@example.com");
    await db.execute(sql`insert into ai_reservations (user_id, call_site, amount, expires_at, worker_id)
      values (${user.id}, 'CV', 1, now() + interval '30 minutes', 'crashing')`);
    let aborted = false;
    let finish!: () => void;
    const hang = new Promise<void>(resolve => { finish = resolve; });
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    let abandoned = 0;
    const queue = new TaskQueue(deps, {
      scan_company: async (_task, _deps, ctx) => {
        started();
        ctx.signal.addEventListener("abort", () => { aborted = true; }, { once: true });
        await hang;
        return {};
      },
    }, { concurrency: 1, workerId: "crashing", pollMs: 10, onAbandon: { scan_company: async () => { abandoned++; } } });
    await enqueueTask(db, "scan_company", { companyId: "culprit" });
    queue.start();
    await running;
    await queue.releaseAfterCrash();
    const row = await theTask();
    // Back on the queue at once rather than after a stale lock, but with its attempt spent: the
    // task that was running may be the one that threw, and must not be retried for ever.
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(1);
    expect(row.runAfter.getTime()).toBeGreaterThan(Date.now());
    expect(aborted).toBe(true);
    expect(abandoned).toBe(0);
    expect(await holdsFor("crashing")).toBe(0);
    finish();
    await queue.stop(1_000);
  }, 15_000);
});

describe("scheduler loop", () => {
  it("never runs two ticks at once, and stops only once the tick in flight has returned", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let ticks = 0;
    let sawAbort = false;
    const tick = async (_deps: WorkerDeps, signal: AbortSignal) => {
      ticks++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Three intervals long, so an interval timer would have started three more beside it.
      for (let step = 0; step < 6 && !signal.aborted; step++) await sleep(10);
      if (signal.aborted) sawAbort = true;
      await sleep(30);
      inFlight--;
    };
    const scheduler = startScheduler(deps, 20, tick);
    while (ticks < 3) await sleep(5);
    const stopping = scheduler.stop();
    expect(inFlight).toBe(1);
    await stopping;
    expect(inFlight).toBe(0);
    expect(maxInFlight).toBe(1);
    expect(sawAbort).toBe(true);
    const after = ticks;
    await sleep(100);
    expect(ticks).toBe(after);
  }, 10_000);
});

/**
 * A scan queued for today is one row for the day. Every path that puts work back on the queue —
 * a handler that outruns its deadline, a lock left behind by a crashed worker, an orderly
 * shutdown — has to reuse that row. A second row would scan the company a second time the same
 * day, which is the one thing the shared catalogue is built to avoid.
 */
it("keeps a requeued company scan on one task row, through a deadline, a stale lock and a shutdown", async () => {
  const [company] = await db.insert(schema.companies).values({ name: "Acme", domain: "acme.example", homepageUrl: "https://acme.example" }).returning();
  const [run] = await db.insert(schema.scanRuns).values({ runDate: "2026-09-05", trigger: "schedule", companiesTotal: 1 }).returning();
  const payload = { companyId: company!.id, scanRunId: run!.id, trigger: "schedule" as const };
  // The daily fan-out suffixes the dedupe key with its run, so a manual rescan neither swallows
  // this task nor is swallowed by it; the run's own key still admits only one.
  const dedupeKey = `${dedupeKeyFor("scan_company", payload)}:${run!.id}`;
  const id = await enqueueTask(db, "scan_company", payload, { dedupeKey, priority: 5 });
  expect(await enqueueTask(db, "scan_company", payload, { dedupeKey, priority: 5 })).toBeNull();

  const theOneTask = async () => {
    const rows = await db.select().from(schema.tasks).where(sql`type = 'scan_company' and payload->>'scanRunId' is not null`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(id);
    return rows[0]!;
  };
  await theOneTask();

  // A "Rescan now" keeps its own key, so it neither swallows the run's task nor is swallowed by
  // it; the handler is what stops it fetching the board again within half an hour.
  const manual = { companyId: company!.id, trigger: "manual" as const };
  const manualKey = dedupeKeyFor("scan_company", manual);
  expect(manualKey).not.toBe(dedupeKey);
  const manualId = await enqueueTask(db, "scan_company", manual, { dedupeKey: manualKey, priority: 5 });
  expect(manualId).not.toBeNull();
  expect(await enqueueTask(db, "scan_company", manual, { dedupeKey: manualKey, priority: 5 })).toBeNull();
  await db.delete(schema.tasks).where(eq(schema.tasks.id, manualId!));

  let release!: () => void;
  const hang = new Promise<void>(resolve => { release = resolve; });
  let runs = 0;
  const handlers = { scan_company: async () => { runs++; await hang; return {}; } };

  // A handler that outruns its three-minute deadline fails and retries in place.
  const slow = new TaskQueue(deps, handlers, { concurrency: 1, workerId: "slow", deadlines: { scan_company: 20 } });
  const claimed = (await claimTask(db, "slow", "scan"))!;
  expect(claimed.id).toBe(id);
  await slow.runTask(claimed);
  const afterDeadline = await theOneTask();
  expect(afterDeadline.status).toBe("queued");
  expect(afterDeadline.error).toContain("TimeoutError");
  expect(afterDeadline.attempts).toBe(1);

  // A worker that crashed with the task claimed: the stale sweep puts the same row back.
  await db.update(schema.tasks).set({ runAfter: sql`now()` }).where(eq(schema.tasks.id, id!));
  expect((await claimTask(db, "crashed", "scan"))!.id).toBe(id);
  await db.update(schema.tasks).set({ lockedAt: new Date(Date.now() - 6 * 60_000) }).where(eq(schema.tasks.id, id!));
  expect(await requeueStale(db)).toEqual({ requeued: 1, failed: 0 });
  expect((await theOneTask()).attempts).toBe(2);
  // Still the same row, and claimable again once its recovery backoff has passed.
  await db.update(schema.tasks).set({ runAfter: sql`now()` }).where(eq(schema.tasks.id, id!));

  // And an orderly shutdown hands it straight back, without spending an attempt.
  let seen!: () => void;
  const running = new Promise<void>(resolve => { seen = resolve; });
  const retiring = new TaskQueue(deps, { scan_company: async () => { runs++; seen(); await hang; return {}; } },
    { concurrency: 1, workerId: "retiring", pollMs: 10 });
  queueUnderTest = retiring;
  retiring.start();
  await running;
  await retiring.stop(50);
  const back = await theOneTask();
  expect(back.status).toBe("queued");
  expect(back.error).toContain("shutting down");
  expect(back.attempts).toBe(2);

  // Three trips through the queue, still one task and one run for the day.
  expect(runs).toBe(2);
  expect(await db.select().from(schema.scanRuns)).toHaveLength(1);
  release();
}, 20_000);

describe("claim ordering", () => {
  const hourAgo = () => new Date(Date.now() - 3600_000);
  /** Queued an hour ago and ready all that time: the shape of a task that has really waited. */
  const backdate = (id: string) => db.update(schema.tasks).set({ createdAt: hourAgo(), runAfter: hourAgo() }).where(eq(schema.tasks.id, id));
  const priorityOf = async (id: string) => (await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]!.priority;
  const ageFully = async () => { for (let sweep = 0; sweep < 20; sweep++) await agePriorities(db); };

  it("claims by stored priority, and ages a waiting task up in a sweep rather than in the claim", async () => {
    // The old claim ordered by an ageing expression no index could serve, so an old task overtook
    // a newer one on every claim. The order is now the stored priority; the sweep is what moves a
    // task that has waited, and it is bounded.
    const old = await enqueueTask(db, "suggest_companies", { n: 1 }, { priority: 5 });
    await enqueueTask(db, "suggest_filters", { n: 2 }, { priority: 4 });
    await backdate(old!);

    expect(await agePriorities(db, 300, 1)).toBe(1);
    expect(await priorityOf(old!)).toBe(4);
    // Same priority now, so the task that has been ready longer goes first.
    expect((await claimTask(db, "w1"))!.id).toBe(old);
  });

  it("never lifts waiting work past the least urgent interactive priority, so fresh requests still come first", async () => {
    // The floor is where a CV build is queued; nothing a person asks for is queued behind it.
    expect(AGEING_PRIORITY_FLOOR).toBe(priorityFor("generate_cv"));
    const score = await enqueueTask(db, "score_job", { userId: "u", jobId: "rescored" }, { priority: priorityFor("score_job") });
    const scan = await enqueueTask(db, "scan_company", { companyId: "a" }, { priority: priorityFor("scan_company") });
    const discover = await enqueueTask(db, "discover", { companyId: "old" }, { priority: priorityFor("discover") });
    for (const id of [score!, scan!, discover!]) await backdate(id);

    await ageFully();
    // Converging on 0 used to put the whole backlog ahead of everything queued after it.
    expect(await priorityOf(score!)).toBe(AGEING_PRIORITY_FLOOR);
    expect(await priorityOf(scan!)).toBe(AGEING_PRIORITY_FLOOR);
    // Work already at the front is never lifted further.
    expect(await priorityOf(discover!)).toBe(priorityFor("discover"));

    // A shortlist score queued now, at the priority the interface gives it, beats the aged
    // backlog in the background lane, and so does a fresh discovery in the fall-through claim.
    const shortlisted = await enqueueTask(db, "score_job", { userId: "u", jobId: "shortlisted" }, { priority: 1 });
    expect((await claimTask(db, "w1", "background"))!.id).toBe(shortlisted);
    await db.delete(schema.tasks).where(eq(schema.tasks.id, discover!));
    const fresh = await enqueueTask(db, "discover", { companyId: "fresh" }, { priority: priorityFor("discover") });
    expect((await claimTask(db, "w1"))!.id).toBe(fresh);
  });

  it("ages only what has been ready for the period, and the longest-waiting first", async () => {
    // A scan spread across the morning is not starving while it waits for its own slot.
    const scheduled = await enqueueTask(db, "scan_company", { companyId: "later" }, { priority: 5 });
    await db.update(schema.tasks).set({ createdAt: hourAgo(), runAfter: new Date(Date.now() + 30 * 60_000) }).where(eq(schema.tasks.id, scheduled!));
    // Queued long ago, but only just past its backoff.
    const retried = await enqueueTask(db, "scan_company", { companyId: "retried" }, { priority: 5 });
    await db.update(schema.tasks).set({ createdAt: hourAgo(), runAfter: new Date(Date.now() - 60_000) }).where(eq(schema.tasks.id, retried!));
    expect(await agePriorities(db)).toBe(0);

    const newer = await enqueueTask(db, "suggest_filters", { n: 1 }, { priority: 6 });
    await db.update(schema.tasks).set({ createdAt: new Date(Date.now() - 20 * 60_000), runAfter: new Date(Date.now() - 20 * 60_000) }).where(eq(schema.tasks.id, newer!));
    const oldest = await enqueueTask(db, "suggest_filters", { n: 2 }, { priority: 3 });
    await backdate(oldest!);
    // The limit takes the one that has waited longest, not the one nearest the front.
    expect(await agePriorities(db, 300, 1)).toBe(1);
    expect(await priorityOf(oldest!)).toBe(2);
    expect(await priorityOf(newer!)).toBe(6);
    expect(await priorityOf(scheduled!)).toBe(5);
  });

  it("keeps a boot-time gate re-evaluation behind a CV build however long it waits", async () => {
    const boot = await enqueueTask(db, "reevaluate_gate", { userId: "u", reason: "boot" }, { dedupeKey: "reevaluate_gate:u:boot", priority: 7 });
    const asked = await enqueueTask(db, "reevaluate_gate", { userId: "v" }, { priority: 6 });
    for (const id of [boot!, asked!]) await backdate(id);
    await ageFully();
    expect(await priorityOf(boot!)).toBe(AGEING_PRIORITY_FLOOR + 1);
    expect(await priorityOf(asked!)).toBe(AGEING_PRIORITY_FLOOR);
    await db.delete(schema.tasks).where(eq(schema.tasks.id, asked!));
    const cv = await enqueueTask(db, "generate_cv", { draftId: "d" }, { priority: priorityFor("generate_cv") });
    expect((await claimTask(db, "w1", "interactive"))!.id).toBe(cv);
  });

  it("skips a row a claim has locked instead of waiting for it", async () => {
    const locked = await enqueueTask(db, "suggest_filters", { n: 1 }, { priority: 6 });
    const free = await enqueueTask(db, "suggest_filters", { n: 2 }, { priority: 6 });
    for (const id of [locked!, free!]) await backdate(id);
    const other = createDb(DATABASE_URL, { max: 1 });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let lockTaken!: () => void;
    const taken = new Promise<void>(resolve => { lockTaken = resolve; });
    const holder = other.db.transaction(async tx => {
      await tx.execute(sql`select id from tasks where id = ${locked!} for update`);
      lockTaken();
      await held;
    });
    try {
      await taken;
      expect(await agePriorities(db)).toBe(1);
      expect(await priorityOf(free!)).toBe(5);
    } finally {
      release();
      await holder;
      await other.pool.end();
    }
    expect(await priorityOf(locked!)).toBe(6);
  });
});


/**
 * What the queue does when the process running a task dies without warning.
 *
 * An out-of-memory is a hard death: no catch, no `failTask`, nothing compares `attempts` with
 * `max_attempts`. Before this, the next boot simply put the task back and claimed it again, so one
 * 41 MB response turned into ten hours of crash looping, a CV draft stuck on "generating" for two
 * and a half hours and six live budget holds for a build that never made a single model call.
 * None of it needs a real crash to reproduce: a task claimed, its lock aged, and another worker
 * sweeping is exactly the same situation.
 */
describe("crash recovery", () => {
  beforeEach(async () => {
    await db.execute(sql`truncate worker_events, cv_drafts, ai_reservations cascade`);
  });

  const past = () => new Date(Date.now() - 60 * 60_000);

  /** A CV build as the worker leaves it mid-flight: the draft generating, its hold live, its task claimed. */
  async function buildInFlight(email: string, workerId: string, attempts: number) {
    const user = await ensureTestUser(db, email);
    const [draft] = await db.insert(schema.cvDrafts).values({
      userId: user.id, jobTitle: "Operations Director", companyName: "Acme", jobDescription: "Lead a team",
      libraryVersion: 1, librarySnapshot: {} as never, model: "claude-sonnet-5", status: "generating", buildStage: "analysing",
    }).returning();
    // The hold names the build it is for, as a live build's does: an account can have two.
    await db.execute(sql`insert into ai_reservations (user_id, call_site, amount, expires_at, worker_id, ref_id)
      values (${user.id}, 'CV', 3.06, now() + interval '30 minutes', ${workerId}, ${draft!.id})`);
    const payload = { draftId: draft!.id };
    await enqueueTask(db, "generate_cv", payload, { dedupeKey: dedupeKeyFor("generate_cv", payload) });
    const task = (await claimTask(db, `${workerId}#0`, "interactive"))!;
    await db.update(schema.tasks).set({ attempts, lockedAt: past() }).where(eq(schema.tasks.id, task.id));
    return { user, draft: draft!, task };
  }

  const heldFor = async (userId: string) =>
    Number((await db.execute<{ n: number }>(sql`select count(*)::int as n from ai_reservations where user_id = ${userId}`)).rows[0]!.n);

  it("spends one attempt per lost worker and gives up at the limit, without ever killing a third worker", async () => {
    await enqueueTask(db, "scan_company", { companyId: "greenhouse-monster" }, {});
    // Three incarnations, each claiming the task and dying with it.
    for (const attempt of [1, 2, 3]) {
      await db.update(schema.tasks).set({ runAfter: sql`now()` });
      const claimed = (await claimTask(db, `pod-${attempt}#0`, "scan"))!;
      expect(claimed.attempts).toBe(attempt);
      await db.update(schema.tasks).set({ lockedAt: past() }).where(eq(schema.tasks.id, claimed.id));
      const outcome = await requeueStale(db, TASK_STALE_AFTER_MS, `pod-${attempt + 1}`);
      expect(outcome).toEqual(attempt < 3 ? { requeued: 1, failed: 0 } : { requeued: 0, failed: 1 });
    }
    const [dead] = await db.select().from(schema.tasks);
    expect(dead!.status).toBe("failed");
    expect(dead!.error).toBe("worker lost while running this task (attempt 3 of 3); not retried");
    expect(dead!.finishedAt).not.toBeNull();
    // And the ledger names it, with the worker that was holding it.
    const [event] = await listWorkerEvents(db, { kinds: ["task_abandoned"] });
    expect(event!.taskType).toBe("scan_company");
    expect(event!.taskId).toBe(dead!.id);
    expect(event!.detail).toMatchObject({ attempts: 3, maxAttempts: 3, lockedBy: "pod-3#0", subject: "scan_company:greenhouse-monster" });
  });

  it("never claims a task that has already spent every attempt, and sweeps it out of the queue", async () => {
    const id = await enqueueTask(db, "discover", { companyId: "a" }, { maxAttempts: 2 });
    await db.update(schema.tasks).set({ attempts: 2 }).where(eq(schema.tasks.id, id!));
    expect(await claimTask(db, "w1")).toBeNull();
    expect(await claimTask(db, "w1", "interactive")).toBeNull();
    // Left alone it would sit queued for ever, so the sweep fails it too.
    expect(await failSpentTasks(db, "sweeper")).toBe(1);
    const [row] = await db.select().from(schema.tasks);
    expect(row!.status).toBe("failed");
    expect(row!.error).toContain("out of attempts (2 of 2 spent)");
  });

  it("sweeps spent tasks at boot and hourly, not on every tick", async () => {
    await ensureTestUser(db, "spent-sweep@example.com");
    const spend = async (companyId: string) => {
      const id = await enqueueTask(db, "discover", { companyId }, { maxAttempts: 1 });
      await db.update(schema.tasks).set({ attempts: 1 }).where(eq(schema.tasks.id, id!));
      return id!;
    };
    const statusOf = async (id: string) => (await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]!.status;
    const atBoot = await spend("boot");
    expect(await recoverFromCrash(deps, { workerId: "spent-pod", onAbandon })).toMatchObject({ requeued: 0, failed: 1 });
    expect(await statusOf(atBoot)).toBe("failed");

    const first = await spend("first");
    await schedulerTick(deps);
    expect(await statusOf(first)).toBe("failed");
    // The read walks every queued row, so a second tick within the hour does not repeat it.
    const second = await spend("second");
    await schedulerTick(deps);
    expect(await statusOf(second)).toBe("queued");
  });

  it("leaves a lost-looking task alone when its owner renews it before the sweep writes", async () => {
    // The sweep reads the row as stale; the owner's renewal, queued behind its own write
    // transaction, lands first. The sweep's write used to match on status and attempts alone and
    // requeue the live run anyway — or, at its last attempt, fail it and run its hook.
    let abandoned = 0;
    for (const attempts of [1, 3]) {
      await db.execute(sql`truncate tasks`);
      await enqueueTask(db, "discover", { companyId: `renewed-${attempts}` }, {});
      const task = (await claimTask(db, "owner#0", "interactive"))!;
      await db.update(schema.tasks).set({ attempts, lockedAt: past() }).where(eq(schema.tasks.id, task.id));
      const owner = createDb(DATABASE_URL, { max: 1 });
      try {
        let renew!: () => void;
        const renewed = new Promise<void>(resolve => { renew = resolve; });
        let locked!: () => void;
        const holding = new Promise<void>(resolve => { locked = resolve; });
        const ownerWrite = owner.db.transaction(async tx => {
          await tx.execute(sql`select id from tasks where id = ${task.id} for update`);
          await tx.execute(sql`update tasks set locked_at = now() where id = ${task.id}`);
          locked();
          await renewed;
        });
        await holding;
        const sweep = requeueStale(db, TASK_STALE_AFTER_MS, "sweeper", { deps, onAbandon: { discover: async () => { abandoned++; } } });
        // Commit the renewal only once the sweep's write is waiting on the row.
        for (let tick = 0; tick < 500; tick++) {
          const waiting = await db.execute(sql`select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`);
          if (waiting.rows.length) break;
          await sleep(10);
        }
        renew();
        await ownerWrite;
        expect(await sweep).toEqual({ requeued: 0, failed: 0 });
      } finally {
        await owner.pool.end();
      }
      const [row] = await db.select().from(schema.tasks);
      expect(row!.status).toBe("running");
      expect(row!.lockedBy).toBe("owner#0");
    }
    expect(abandoned).toBe(0);
  });

  it("reclaims its own earlier incarnation's rows at boot, and nobody else's live ones", async () => {
    await enqueueTask(db, "scan_company", { companyId: "theirs" }, {});
    const theirs = (await claimTask(db, "other-pod#0", "scan"))!;
    await enqueueTask(db, "scan_company", { companyId: "ours" }, {});
    const ours = (await claimTask(db, "this-pod#1", "scan"))!;
    // Both locks are fresh; the list names both, as a boot that read one of them stale would.
    const outcome = await requeueStale(db, TASK_STALE_AFTER_MS, "this-pod", { ids: [theirs.id, ours.id] });
    expect(outcome).toEqual({ requeued: 1, failed: 0 });
    const status = async (id: string) => (await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]!.status;
    expect(await status(theirs.id)).toBe("running");
    expect(await status(ours.id)).toBe("queued");
  });

  it("leaves a task whose failure could not be written to the stale sweep, hooks and all", async () => {
    // A failTask that throws is not a task failed for good: the row is still running, and the
    // sweep that later finds it is the one that decides and closes off what it was for.
    let abandoned = 0;
    let broken = false;
    const flaky = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "update" && broken) return () => { throw new Error("connection terminated unexpectedly"); };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Db;
    const hooks = { discover: async () => { abandoned++; } };
    const queue = new TaskQueue({ ...deps, db: flaky }, {
      discover: async () => { broken = true; throw new Error("handler failed"); },
    }, { concurrency: 1, workerId: "flaky", onAbandon: hooks });
    await enqueueTask(db, "discover", { companyId: "flaky" }, { maxAttempts: 1 });
    await queue.runTask((await claimTask(db, "flaky"))!);
    broken = false;

    expect(abandoned).toBe(0);
    expect(await listWorkerEvents(db, { kinds: ["task_abandoned"] })).toHaveLength(0);
    expect((await db.select().from(schema.tasks))[0]!.status).toBe("running");

    expect(await requeueStale(db, 0, "sweeper", { deps, onAbandon: hooks })).toEqual({ requeued: 0, failed: 1 });
    expect(abandoned).toBe(1);
    expect((await db.select().from(schema.tasks))[0]!.status).toBe("failed");
  });

  it("fails the CV draft and releases its account's hold when the build task is given up on", async () => {
    const { user, draft } = await buildInFlight("abandoned-build@example.com", "pod-a", 3);
    expect(await heldFor(user.id)).toBe(1);

    const outcome = await requeueStale(db, TASK_STALE_AFTER_MS, "pod-b", { deps, onAbandon });
    expect(outcome).toEqual({ requeued: 0, failed: 1 });

    const [after] = await db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
    expect(after!.status).toBe("failed");
    expect(after!.error).toBe(CV_ABANDONED_MESSAGE);
    expect(after!.buildStage).toBeNull();
    // Nothing is spending the hold any more, and the rebuild we just asked for must not be refused.
    expect(await heldFor(user.id)).toBe(0);
    const [event] = await listWorkerEvents(db, { kinds: ["task_abandoned"] });
    expect(event!.taskType).toBe("generate_cv");
    expect(event!.detail).toMatchObject({ subject: `generate_cv:${draft.id}` });
  });

  it("does not let the pre-quiz task fail or annotate a continuation already queued for the same draft", async () => {
    const { user, draft, task } = await buildInFlight("quiz-continuation@example.com", "pod-a", 3);
    const completedAt = new Date(Date.now() + 1_000);
    await db.update(schema.cvDrafts).set({
      status: "queued",
      failure: null,
      gapQuiz: { status: "skipped", questions: [], completedAt: completedAt.toISOString() } as never,
    }).where(eq(schema.cvDrafts.id, draft.id));
    await enqueueTask(db, "generate_cv", { draftId: draft.id }, {
      dedupeKey: `generate_cv:${draft.id}:quiz-complete`, priority: 2,
    });

    expect(await requeueStale(db, TASK_STALE_AFTER_MS, "pod-b", { deps, onAbandon })).toEqual({ requeued: 0, failed: 1 });
    let [continued] = await db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
    expect(continued!.status).toBe("queued");
    expect(continued!.failure).toBeNull();
    expect(await heldFor(user.id)).toBe(1);

    // The same guard applies when the old run is interrupted with another attempt available.
    await onInterrupted.generate_cv!(task, deps, { retryAt: new Date(Date.now() + 60_000).toISOString() });
    [continued] = await db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
    expect(continued!.status).toBe("queued");
    expect(continued!.failure).toBeNull();

    // A later ordinary retry can reuse the legacy key. Its failure is real work ending, not the
    // pre-quiz delivery arriving late, so it must close the draft and return the budget hold.
    await db.update(schema.tasks).set({ status: "done" })
      .where(eq(schema.tasks.dedupeKey, `generate_cv:${draft.id}:quiz-complete`));
    await onAbandon.generate_cv!({ ...task, createdAt: new Date(completedAt.getTime() + 1_000) }, deps, "later retry failed");
    [continued] = await db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
    expect(continued!.status).toBe("failed");
    expect(await heldFor(user.id)).toBe(0);
  });

  it("leaves a build that still has attempts alone, draft and hold included", async () => {
    const { user, draft } = await buildInFlight("retryable-build@example.com", "pod-a", 1);
    expect(await requeueStale(db, TASK_STALE_AFTER_MS, "pod-b", { deps, onAbandon })).toEqual({ requeued: 1, failed: 0 });
    const [after] = await db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
    expect(after!.status).toBe("generating");
    expect(await heldFor(user.id)).toBe(1);
  });

  it("recovers everything a previous incarnation was running, and drops the holds it left behind", async () => {
    const { user, draft, task: cvTask } = await buildInFlight("crashed-pod@example.com", "pod-x", 3);
    const other = await ensureTestUser(db, "someone-else@example.com");
    await db.execute(sql`insert into ai_reservations (user_id, call_site, amount, expires_at, worker_id)
      values (${other.id}, 'CV', 2, now() + interval '30 minutes', 'another-pod')`);
    await enqueueTask(db, "scan_company", { companyId: "acme" }, {});
    const scan = (await claimTask(db, "pod-x#1", "scan"))!;
    // The lock is fresh: this process has claimed nothing, so a running task is still not its own.
    await db.update(schema.tasks).set({ lockedAt: new Date() }).where(eq(schema.tasks.id, scan.id));

    const recovery = await recoverFromCrash(deps, { workerId: "pod-x", onAbandon });

    expect(recovery.suspects).toHaveLength(2);
    expect(recovery.likely!.id).toBe(cvTask.id);
    expect(recovery.likely!.attempts).toBe(3);
    expect(recovery.likely!.subject).toBe(`generate_cv:${draft.id}`);
    expect(recovery).toMatchObject({ requeued: 1, failed: 1 });
    expect(recovery.holds).toEqual({ count: 1, amountUsd: 3.06 });

    const rows = await db.select().from(schema.tasks).orderBy(schema.tasks.type);
    expect(rows.find(r => r.type === "generate_cv")!.status).toBe("failed");
    expect(rows.find(r => r.type === "scan_company")!.status).toBe("queued");
    // The build that was killed with it is failed, its hold gone; nobody else's hold is touched.
    expect((await db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id)))[0]!.status).toBe("failed");
    expect(await heldFor(user.id)).toBe(0);
    expect(await heldFor(other.id)).toBe(1);

    const [crash] = await listWorkerEvents(db, { kinds: ["crash_recovery"] });
    expect(crash!.workerId).toBe("pod-x");
    expect((crash!.detail.suspects as unknown[])).toHaveLength(2);
    expect(crash!.detail.likely).toMatchObject({ id: cvTask.id, attempts: 3, lockedBy: "pod-x#0" });
    const [released] = await listWorkerEvents(db, { kinds: ["holds_released"] });
    expect(released!.detail).toMatchObject({ count: 1, reason: "boot" });
  });

  it("leaves a task another live pod is running alone, however fresh this boot is", async () => {
    // Render can overlap two pods for a moment during a deploy. A running task locked by a
    // different worker whose lock is still being renewed is that worker's, not this one's.
    await enqueueTask(db, "scan_company", { companyId: "acme" }, {});
    const theirs = (await claimTask(db, "another-pod#0", "scan"))!;
    const recovery = await recoverFromCrash(deps, { workerId: "pod-y", onAbandon });
    expect(recovery.suspects).toEqual([]);
    expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, theirs.id)))[0]!.status).toBe("running");
    // Once its lock has aged out, the ordinary sweep takes it.
    await db.update(schema.tasks).set({ lockedAt: past() }).where(eq(schema.tasks.id, theirs.id));
    expect(await requeueStale(db, TASK_STALE_AFTER_MS, "pod-y")).toEqual({ requeued: 1, failed: 0 });
  });

  it("records nothing and touches nothing when the previous process exited cleanly", async () => {
    await enqueueTask(db, "discover", { companyId: "a" }, {});
    const recovery = await recoverFromCrash(deps, { workerId: "tidy-pod", onAbandon });
    expect(recovery).toMatchObject({ suspects: [], likely: null, requeued: 0, failed: 0 });
    expect(await listWorkerEvents(db, { kinds: ["crash_recovery"] })).toHaveLength(0);
    expect((await db.select().from(schema.tasks))[0]!.status).toBe("queued");
  });

  it("fails a CV draft no task is building any more, and leaves a live build alone", async () => {
    const { user, draft } = await buildInFlight("orphan-build@example.com", "pod-a", 1);
    const live = await buildInFlight("live-build@example.com", "pod-a", 1);
    // A resumed quiz uses a different dedupe key, but is still the task building this draft.
    await db.update(schema.tasks).set({ dedupeKey: `generate_cv:${live.draft.id}:quiz-complete` })
      .where(sql`payload->>'draftId' = ${live.draft.id}`);
    // The orphan's task is gone (history maintenance takes finished rows after thirty days);
    // the other's is still running, and its draft is nobody's business.
    await db.delete(schema.tasks).where(sql`payload->>'draftId' = ${draft.id}`);
    await db.update(schema.cvDrafts).set({ createdAt: new Date(Date.now() - 30 * 60_000) });

    expect(await reconcileCvDrafts(deps)).toBe(1);
    const [orphan] = await db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
    expect(orphan!.status).toBe("failed");
    expect(orphan!.error).toBe(CV_ABANDONED_MESSAGE);
    expect(await heldFor(user.id)).toBe(0);
    expect((await db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, live.draft.id)))[0]!.status).toBe("generating");
    expect(await heldFor(live.user.id)).toBe(1);

    // A build whose task failed is in the same position, and the sweep is idempotent.
    await db.update(schema.tasks).set({ status: "failed" }).where(sql`payload->>'draftId' = ${live.draft.id}`);
    expect(await reconcileCvDrafts(deps)).toBe(1);
    expect(await reconcileCvDrafts(deps)).toBe(0);
  });

  it("releases a hold whose build is gone, as when a crashed pod's draft was discarded", async () => {
    // Production on 18 Sep: six $3.06 holds taken by two crashed pods outlived their builds and
    // refused the next build for half an hour, because a boot releases only its own pod's holds.
    const gone = await buildInFlight("discarded-build@example.com", "dead-pod", 1);
    const live = await buildInFlight("live-build@example.com", "pod-a", 1);
    await db.delete(schema.tasks).where(sql`payload->>'draftId' = ${gone.draft.id}`);
    await db.delete(schema.cvDrafts).where(eq(schema.cvDrafts.id, gone.draft.id));
    await db.execute(sql`update ai_reservations set created_at = now() - interval '10 minutes'`);

    expect(await reconcileCvDrafts(deps)).toBe(0);
    expect(await heldFor(gone.user.id)).toBe(0);
    expect(await heldFor(live.user.id)).toBe(1);
    const events = await listWorkerEvents(db, { kinds: ["holds_released"] });
    expect(events[0]?.detail).toMatchObject({ count: 1, reason: "orphaned" });
  });

  it("leaves a draft whose build has only just been queued", async () => {
    const { draft } = await buildInFlight("fresh-build@example.com", "pod-a", 1);
    await db.delete(schema.tasks).where(sql`payload->>'draftId' = ${draft.id}`);
    expect(await reconcileCvDrafts(deps)).toBe(0);
    expect((await db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id)))[0]!.status).toBe("generating");
  });
});

/**
 * The run's own signal, and the beat that keeps it.
 *
 * A handler used to run on regardless: nothing could cancel it, and the one thing that kept its
 * claim alive was a latch that a single hung query turned off for good. Both are how two workers
 * ended up running one task at the same time.
 */
describe("keeping a run alive, and stopping one that is over", () => {
  it("stops a run whose task another worker has taken", async () => {
    let aborted: boolean | null = null;
    const handler = async (task: schema.Task, _deps: WorkerDeps, ctx: { signal: AbortSignal }) => {
      // Another worker claims the task out from under this run: the heartbeat is how it finds out.
      await db.update(schema.tasks).set({ attempts: 5, lockedBy: "another-pod#0" }).where(eq(schema.tasks.id, task.id));
      await new Promise<void>(resolve => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
      aborted = ctx.signal.aborted;
      return { stopped: true };
    };
    await enqueueTask(db, "generate_cv", { draftId: "11111111-1111-1111-1111-111111111111" });
    const queue = new TaskQueue(deps, { generate_cv: handler }, { concurrency: 1, workerId: "stolen", heartbeatMs: 20 });
    await queue.drain();
    expect(aborted).toBe(true);
    // The task belongs to the worker that took it, and this run's completion was discarded.
    const [row] = await db.select().from(schema.tasks);
    expect(row!.status).toBe("running");
    expect(row!.lockedBy).toBe("another-pod#0");
  }, 15_000);

  it("refuses a stopped run's writes while its row still says it owns the task", async () => {
    // Between the deadline and `failTask`, the row is still this run's: only the signal says the
    // run has been given up on, and an unwinding handler must not commit what the abort left it.
    await enqueueTask(db, "scan_company", { companyId: "cut-off" });
    const task = (await claimTask(db, "fenced#0", "scan"))!;
    const run = new AbortController();
    await db.transaction(async tx => assertRunOwnership(tx as unknown as Db, task, run.signal));
    run.abort(new Error("deadline"));
    await expect(db.transaction(async tx => assertRunOwnership(tx as unknown as Db, task, run.signal))).rejects.toThrow("Run was stopped");
    expect((await db.select().from(schema.tasks))[0]!.status).toBe("running");
  });

  it("hands a handler the run's signal with its deps, and a timed-out run stops renewing its lease", async () => {
    const key = `zombie-${Date.now()}`;
    const expiresAt = async () => (await db.execute<{ at: string }>(sql`select expires_at::text as at from resource_leases where key = ${key}`)).rows[0]?.at;
    let finish!: () => void;
    const zombie = new Promise<void>(resolve => { finish = resolve; });
    let observed!: { sameSignal: boolean; renewedBefore: boolean; renewedAfter: boolean; fenced: string };
    let settled!: () => void;
    const done = new Promise<void>(resolve => { settled = resolve; });
    const queue = new TaskQueue(deps, {
      discover: (_task, runDeps, ctx) => withResourceLease(runDeps, key, async locked => {
        const first = await expiresAt();
        let renewedBefore = false;
        for (let tick = 0; tick < 100 && !renewedBefore; tick++) { await sleep(10); renewedBefore = (await expiresAt()) !== first; }
        // The handler ignores its abort, as a scan or a discovery does today.
        await new Promise(resolve => ctx.signal.addEventListener("abort", resolve, { once: true }));
        await sleep(60); // any renewal already in flight lands
        const atAbort = await expiresAt();
        await sleep(150); // seven renewal intervals
        const renewedAfter = (await expiresAt()) !== atAbort;
        const fenced = await db.transaction(async tx => locked.assertOwnership!(tx as unknown as Db)).then(() => "passed", (e: Error) => e.message);
        observed = { sameSignal: (runDeps as RunDeps).signal === ctx.signal, renewedBefore, renewedAfter, fenced };
        settled();
        await zombie;
        return {};
      }, { renewEveryMs: 20 }),
    }, { concurrency: 1, workerId: "zombie", deadlines: { discover: 400 } });
    await enqueueTask(db, "discover", { companyId: "slow" }, { maxAttempts: 2 });
    await queue.runTask((await claimTask(db, "zombie"))!);
    await done;
    expect(observed).toEqual({ sameSignal: true, renewedBefore: true, renewedAfter: false, fenced: "Run was stopped; refusing its writes" });
    finish();
    await db.execute(sql`delete from resource_leases where key = ${key}`);
  }, 15_000);

  it("stops refunding busy bounces once a task has been bouncing for hours", async () => {
    // A bounce is normally free: someone else is doing the same thing. One that never ends is
    // waiting on something that is not finishing, and must not be retried for ever.
    await enqueueTask(db, "scan_company", { companyId: "busy" }, { maxAttempts: 2 });
    let task = (await claimTask(db, "busy#0", "scan"))!;
    expect(await failTask(db, task, new LeaseBusyError("Operation already running: scan:busy"))).toBe("retry");
    expect((await db.select().from(schema.tasks))[0]!.attempts).toBe(0);

    await db.update(schema.tasks).set({ runAfter: sql`now()`, createdAt: new Date(Date.now() - BUSY_REFUND_WINDOW_MS - 60_000) });
    for (const expected of ["retry", "failed"] as const) {
      task = (await claimTask(db, "busy#0", "scan"))!;
      expect(await failTask(db, task, new LeaseBusyError("Operation already running: scan:busy"))).toBe(expected);
      await db.update(schema.tasks).set({ runAfter: sql`now()` });
    }
    const [row] = await db.select().from(schema.tasks);
    expect(row!.status).toBe("failed");
    expect(row!.attempts).toBe(2);
  });

  it("keeps renewing a claim when one renewal never comes back", async () => {
    await enqueueTask(db, "generate_cv", { draftId: "22222222-2222-2222-2222-222222222222" });
    const task = (await claimTask(db, "hung#0", "interactive"))!;
    let renewals = 0;
    // A database that answers the completion but never the renewals: one hung query used to latch
    // the heartbeat off for good, the claim went stale in five minutes, and a second attempt ran
    // beside the first.
    const hangingDb = {
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: () => {
              if ("status" in values) return Promise.resolve([{ id: task.id }]);
              renewals++;
              return new Promise(() => {});
            },
          }),
        }),
      }),
    } as unknown as Db;
    const queue = new TaskQueue({ ...deps, db: hangingDb }, {
      generate_cv: () => new Promise(resolve => setTimeout(() => resolve({ ok: true }), 250)),
    }, { concurrency: 1, workerId: "hung", heartbeatMs: 30 });

    await queue.runTask(task);

    expect(renewals).toBeGreaterThan(1);
  }, 15_000);
});
