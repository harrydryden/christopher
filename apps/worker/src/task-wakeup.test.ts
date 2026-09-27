/**
 * An idle queue against a real database: it backs off while nothing arrives, starts a task the
 * moment its enqueue commits, and picks up what was enqueued while its listener was away.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createDb, enqueueTask, schema, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { sql } from "drizzle-orm";
import { testDatabaseUrl } from "./test-users";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { sleep, TaskDeferred, TaskQueue } from "./queue";
import { TaskWakeup } from "./task-wakeup";

const SUITE = "ava-wakeup-test";
const DATABASE_URL = testDatabaseUrl(SUITE);
let deps: WorkerDeps;
let db: Db;
let queue: TaskQueue | null = null;
let wakeup: TaskWakeup | null = null;

beforeAll(async () => {
  const bootstrap = createDb(DATABASE_URL, { max: 1 });
  await runMigrations(bootstrap.db);
  await bootstrap.pool.end();
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.AVA_DISABLE_BROWSER = "1";
  deps = await createDeps(readEnv(), { settingsTtlMs: 0 });
  db = deps.db;
}, 60_000);
afterAll(async () => { await deps?.close(); });
beforeEach(async () => { await db.execute(sql`truncate tasks restart identity cascade`); });
afterEach(async () => {
  await queue?.stop(1000);
  await wakeup?.stop();
  queue = null;
  wakeup = null;
});

/** Resolves with how long after `from` the handler first ran. */
function handlerTimer() {
  let ran!: (ms: number) => void;
  const first = new Promise<number>(resolve => { ran = resolve; });
  let from = 0;
  return { mark: () => { from = performance.now(); }, handler: async () => { ran(performance.now() - from); return { ok: true }; }, first };
}

const within = <T>(work: Promise<T>, ms: number, what: string) =>
  Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(what)), ms))]);

it("waits longer after each empty claim, up to its ceiling, and starts again from the first wait after a claim", async () => {
  const waits: number[] = [];
  const recorder = { listening: false, wait: async (ms: number) => { waits.push(ms); await sleep(ms); } };
  let handled = 0;
  queue = new TaskQueue(deps, { discover: async () => { handled++; return {}; } }, { concurrency: 1, workerId: "backoff", pollMs: 20, idlePollMaxMs: 160, wakeup: recorder });
  queue.start();
  await within((async () => { while (waits.length < 6) await sleep(10); })(), 5_000, "the queue stopped polling");
  expect(waits.slice(0, 6)).toEqual([20, 40, 80, 160, 160, 160]);
  const beforeEnqueue = waits.length;
  await enqueueTask(db, "discover", { companyId: "a" });
  await within((async () => { while (!handled) await sleep(10); })(), 2_000, "the task was never claimed");
  await sleep(100);
  // The claim reset the wait to the first one. The slot may have logged a ceiling wait or two
  // before the notification reached it, and may already have moved past the first wait again by
  // the time this looks, so the assertion is on the first wait after the ceiling, not on an index.
  const afterClaim = waits.slice(beforeEnqueue).filter(ms => ms !== 160);
  expect(afterClaim[0]).toBe(20);
}, 20_000);

it("does not sleep through a notification that arrived while the slot was claiming", async () => {
  // Unit: a wait told the generation read before the claim ends at once if a wake came since.
  const unit = new TaskWakeup("postgres://unused@127.0.0.1:1/none");
  const before = unit.generation;
  unit.wake();
  await within(unit.wait(10_000, before), 500, "a wait slept through a wake that came during the claim");
  // And one told the current generation waits as before.
  let ended = false;
  void unit.wait(300, unit.generation).then(() => { ended = true; });
  await sleep(100);
  expect(ended).toBe(false);
  await unit.stop();

  // The queue reads the generation before it claims and hands it to the wait: a notification
  // delivered between the claim's snapshot and the wait (the enqueue it announces invisible to
  // that claim) would otherwise cost up to the 30 s ceiling.
  const generation = 0;
  const seen: Array<{ since: number | undefined; now: number }> = [];
  const stub = {
    listening: true,
    get generation() { return generation; },
    wait: async (ms: number, since?: number) => {
      seen.push({ since, now: generation });
      if (since !== undefined && since !== generation) return;
      await sleep(ms);
    },
  };
  queue = new TaskQueue(deps, { discover: async () => ({}) }, { concurrency: 1, workerId: "claiming", pollMs: 5_000, wakeup: stub });
  queue.start();
  await within((async () => { while (seen.length < 1) await sleep(5); })(), 2_000, "the queue never waited");
  expect(seen[0]!.since).toBe(0);
}, 20_000);

it("starts a task within a second of its enqueue while the queue is polling only every ten seconds", async () => {
  wakeup = new TaskWakeup(testDatabaseUrl(`${SUITE}-listener`));
  wakeup.start();
  await within((async () => { while (!wakeup!.listening) await sleep(20); })(), 5_000, "the listener never connected");
  const timer = handlerTimer();
  queue = new TaskQueue(deps, { discover: timer.handler }, { concurrency: 1, workerId: "notified", pollMs: 10_000, wakeup });
  queue.start();
  // Every slot has found the queue empty and is in its ten-second wait.
  await sleep(500);
  timer.mark();
  await enqueueTask(db, "discover", { companyId: "a" });
  const latency = await within(timer.first, 5_000, "the enqueue did not wake the queue");
  expect(latency).toBeLessThan(1_000);
}, 20_000);

it("runs a deferred task again when it comes due, not on the next ten-second poll", async () => {
  wakeup = new TaskWakeup(testDatabaseUrl(`${SUITE}-listener`));
  wakeup.start();
  await within((async () => { while (!wakeup!.listening) await sleep(20); })(), 5_000, "the listener never connected");
  const runs: number[] = [];
  let dueAt = 0;
  queue = new TaskQueue(deps, {
    poll_score_batch: async () => {
      runs.push(performance.now());
      if (runs.length > 1) return { applied: true };
      dueAt = performance.now() + 400;
      return new TaskDeferred(new Date(Date.now() + 400), { status: "in_progress" });
    },
  }, { concurrency: 1, workerId: "deferring", pollMs: 10_000, wakeup });
  queue.start();
  await sleep(300);
  await enqueueTask(db, "poll_score_batch", { batchId: "msgbatch_due", items: [], holds: {} } as unknown as Record<string, unknown>);
  await within((async () => { while (runs.length < 2) await sleep(10); })(), 3_000, "the deferred task waited for the poll");
  expect(runs[1]! - dueAt).toBeLessThan(1_000);
}, 20_000);

it("never wakes the queue for an enqueue that rolled back", async () => {
  wakeup = new TaskWakeup(testDatabaseUrl(`${SUITE}-listener`));
  wakeup.start();
  await within((async () => { while (!wakeup!.listening) await sleep(20); })(), 5_000, "the listener never connected");
  let woken = false;
  void wakeup.wait(5_000).then(() => { woken = true; });
  await db.transaction(async tx => {
    await enqueueTask(tx, "discover", { companyId: "a" });
    tx.rollback();
  }).catch(() => undefined);
  await sleep(300);
  expect(woken).toBe(false);
  await enqueueTask(db, "discover", { companyId: "b" });
  await sleep(300);
  expect(woken).toBe(true);
}, 20_000);

it("reconnects a lost listener and looks once, finding what was enqueued while it was away", async () => {
  wakeup = new TaskWakeup(testDatabaseUrl(`${SUITE}-listener`));
  wakeup.start();
  await within((async () => { while (!wakeup!.listening) await sleep(20); })(), 5_000, "the listener never connected");
  const timer = handlerTimer();
  queue = new TaskQueue(deps, { discover: timer.handler }, { concurrency: 1, workerId: "reconnecting", pollMs: 10_000, wakeup });
  queue.start();
  await sleep(300);
  await db.execute(sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = ${`${SUITE}-listener`} and pid <> pg_backend_pid()`);
  await within((async () => { while (wakeup!.listening) await sleep(20); })(), 5_000, "the listener never noticed");
  // Written without a notification, as nobody was listening to hear one.
  timer.mark();
  await db.insert(schema.tasks).values({ type: "discover", payload: { companyId: "a" } });
  const latency = await within(timer.first, 8_000, "the reconnect did not look at the queue");
  expect(wakeup.listening).toBe(true);
  expect(latency).toBeLessThan(5_000);
}, 30_000);
