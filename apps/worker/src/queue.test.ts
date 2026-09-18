/** Queue and scheduler behaviour against a real database. */
import { renewTask, completeTask, assertTaskOwnership } from "./queue";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {createDb, enqueueTask, listUserIds, schema, setSubscriptionStatus, subscribeToCompany, type Db} from "@christopher/db";
import { dedupeKeyFor, isUserSettingsKey } from "@christopher/core";
import { ensureTestUser } from "./test-users";
import { runMigrations } from "@christopher/db/migrate";
import { desc, eq, sql } from "drizzle-orm";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { agePriorities, backoffMs, claimTask, deadlineMsFor, failTask, laneSlots, requeueStale, TaskQueue } from "./queue";
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
  expect(await requeueStale(db)).toBe(0);
});

it("recovers a stopped worker after five missed minutes while retaining a fresh long-running task", async () => {
  await enqueueTask(db, "generate_cv", { draftId: "stopped" });
  await enqueueTask(db, "generate_cv", { draftId: "live" });
  const stopped = (await claimTask(db, "retiring-worker"))!;
  const live = (await claimTask(db, "current-worker"))!;
  await db.update(schema.tasks).set({ lockedAt: new Date(Date.now() - 6 * 60_000) }).where(eq(schema.tasks.id, stopped.id));
  await db.update(schema.tasks).set({ startedAt: new Date(Date.now() - 30 * 60_000), lockedAt: new Date(Date.now() - 60_000) }).where(eq(schema.tasks.id, live.id));
  expect(await requeueStale(db)).toBe(1);
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
    expect(deadlineMsFor("generate_cv")).toBe(30 * 60_000);
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
  await db.update(schema.tasks).set({ runAfter: new Date() }).where(eq(schema.tasks.id, id!));
  expect((await claimTask(db, "crashed", "scan"))!.id).toBe(id);
  await db.update(schema.tasks).set({ lockedAt: new Date(Date.now() - 6 * 60_000) }).where(eq(schema.tasks.id, id!));
  expect(await requeueStale(db)).toBe(1);
  expect((await theOneTask()).attempts).toBe(2);

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
  it("claims by stored priority, and ages a waiting task up in a sweep rather than in the claim", async () => {
    // The old claim ordered by an ageing expression no index could serve, so an old task overtook
    // a newer one on every claim. The order is now the stored priority; the sweep is what moves a
    // task that has waited, and it is bounded.
    const old = await enqueueTask(db, "suggest_companies", { n: 1 }, { priority: 5 });
    await enqueueTask(db, "suggest_filters", { n: 2 }, { priority: 4 });
    await db.update(schema.tasks).set({ createdAt: new Date(Date.now() - 3600_000) }).where(eq(schema.tasks.id, old!));

    expect(await agePriorities(db, 300, 1)).toBe(1);
    expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, old!)))[0]!.priority).toBe(4);
    // Same priority now, so the older task goes first.
    expect((await claimTask(db, "w1"))!.id).toBe(old);

    // A task already at the front of the queue is left alone however long it has waited.
    await db.update(schema.tasks).set({ status: "queued", priority: 0, createdAt: new Date(Date.now() - 3600_000) });
    expect(await agePriorities(db)).toBe(0);
    const priorities = (await db.select().from(schema.tasks)).map(t => t.priority);
    expect(priorities.sort()).toEqual([0, 0]);
  });
});
