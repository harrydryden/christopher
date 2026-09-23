import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createDb, schema } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { sql } from "drizzle-orm";
import { accountAiStanding, BudgetRefusedError, isAccountBudgetRefusal, tryReserveAi, UNLIMITED_AI_BUDGET_USD } from "./budget";
import { aiBudgetStop, type WorkerDeps } from "./context";
import { ensureTestUser } from "./test-users";

/**
 * Admission against the account's budget and the deployment's optional caps.
 *
 * The caps are unset in the ordinary deployment, so the path every model call takes must not pay
 * for them: no day total over every account's calls, and no lock shared by the whole deployment.
 * The account's own budget is still judged under a lock of its own, so it stays exact.
 */
const { db, pool } = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test");
beforeAll(() => runMigrations(db));
beforeEach(() => db.execute(sql`truncate ai_calls, ai_reservations`));
// Holds are left live on purpose here; the suites after this one share the database.
afterAll(async () => { await db.execute(sql`truncate ai_calls, ai_reservations`); await pool.end(); });

const since = new Date("2026-01-01T00:00:00Z");
const within = <T>(work: Promise<T>, ms = 5_000) =>
  Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("blocked")), ms))]);

/** Hold an advisory lock on a connection of its own, as another process in the middle of a hold would. */
async function holdLock(key: string) {
  const client = await pool.connect();
  await client.query("select pg_advisory_lock(hashtext($1))", [key]);
  let held = true;
  return async () => {
    if (!held) return;
    held = false;
    await client.query("select pg_advisory_unlock(hashtext($1))", [key]);
    client.release();
  };
}

async function waitingOnAdvisoryLock() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const rows = await db.execute<{ n: number }>(sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`);
    if (Number(rows.rows[0]?.n) > 0) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error("no hold ever waited on the lock");
}

it("reads no day total and takes no deployment-wide lock when no cap is set", async () => {
  const user = await ensureTestUser(db, "uncapped@example.com");
  // Two million dollars spent today across the deployment: with no cap set, that refuses nothing.
  await db.insert(schema.aiCalls).values({ callSite: "A3", model: "fixture", costUsd: 2_000_000 });
  const release = await holdLock("ava:ai-budget");
  try {
    const shared = await within(tryReserveAi(db, "A3", 5, {}));
    expect("release" in shared).toBe(true);
    // The environment's unlimited default is no cap either.
    const account = await within(tryReserveAi(db, "A5", 0.5, {
      account: { userId: user.id, budgetUsd: 1, since }, daily: UNLIMITED_AI_BUDGET_USD, discovery: UNLIMITED_AI_BUDGET_USD,
    }));
    expect("release" in account).toBe(true);
    // A cap that is set still takes the deployment's lock and waits for it.
    const capped = tryReserveAi(db, "A3", 5, { daily: 10 });
    await waitingOnAdvisoryLock();
    await release();
    const refused = await within(capped);
    expect(refused).toEqual({ refused: { limit: "day", limitUsd: 10, spent: 2_000_000, held: 5.5 } });
  } finally {
    await release();
  }
});

it("never makes one account's hold wait on another's", async () => {
  const [a, b] = await Promise.all([ensureTestUser(db, "account-a@example.com"), ensureTestUser(db, "account-b@example.com")]);
  const release = await holdLock(`ava:ai-budget:${a.id}`);
  try {
    const other = await within(tryReserveAi(db, "A5", 0.1, { account: { userId: b.id, budgetUsd: 1, since } }));
    expect("release" in other).toBe(true);
    const same = tryReserveAi(db, "A5", 0.1, { account: { userId: a.id, budgetUsd: 1, since } });
    await waitingOnAdvisoryLock();
    await release();
    expect("release" in await within(same)).toBe(true);
  } finally {
    await release();
  }
});

it("still judges one account's concurrent holds one at a time, with no cap set", async () => {
  const user = await ensureTestUser(db, "concurrent@example.com");
  const holds = await Promise.all(Array.from({ length: 10 }, () =>
    tryReserveAi(db, "A5", 0.3, { account: { userId: user.id, budgetUsd: 1, since } })));
  expect(holds.filter(hold => "release" in hold)).toHaveLength(3);
});

it("counts no expired hold, whether or not anything has deleted it yet", async () => {
  const user = await ensureTestUser(db, "expired@example.com");
  await db.execute(sql`insert into ai_reservations (user_id, call_site, amount, expires_at) values (${user.id}, 'CV', 50, now() - interval '1 minute')`);
  expect(await accountAiStanding(db, user.id, since)).toEqual({ spent: 0, held: 0 });
  expect("release" in await tryReserveAi(db, "A5", 0.5, { account: { userId: user.id, budgetUsd: 1, since } })).toBe(true);
});

it("adds a day of small calls in double precision, so the cap sees every one of them", async () => {
  // In single precision a call below half the spacing at $4,000 vanishes from the running sum.
  await db.insert(schema.aiCalls).values({ callSite: "A3", model: "fixture", costUsd: 4_000 });
  await db.insert(schema.aiCalls).values(Array.from({ length: 1_000 }, () => ({ callSite: "A5", model: "fixture", costUsd: 0.0001 })));
  const hold = await tryReserveAi(db, "A5", 0.01, { daily: 4_000.05 });
  expect(hold).toMatchObject({ refused: { limit: "day" } });
  expect((hold as { refused: { spent: number } }).refused.spent).toBeCloseTo(4_000.1, 3);
});

it("stops work before it starts once live holds fill what the month has left", async () => {
  const user = await ensureTestUser(db, "held-out@example.com");
  const deps = {
    db, ai: { enabled: true }, now: () => new Date(),
    userSettings: async () => ({ aiBudgetUsd: 1, aiBudgetResetAt: null }),
  } as unknown as WorkerDeps;
  // Figures a real column holds exactly, so the edge is the edge.
  await db.insert(schema.aiCalls).values({ userId: user.id, callSite: "A5", model: "fixture", costUsd: 0.25 });
  expect(await aiBudgetStop(deps, user.id)).toBeNull();
  // A CV build is holding the rest of the month: recorded spend alone would have let this through.
  const build = await tryReserveAi(db, "CV", 0.75, { account: { userId: user.id, budgetUsd: 1, since } });
  expect("release" in build).toBe(true);
  expect(await aiBudgetStop(deps, user.id)).toBe("account ai budget exceeded");
  // And the per-call hold, doing the same arithmetic, refuses in the account's name.
  const refused = await tryReserveAi(db, "A5", 0.01, { account: { userId: user.id, budgetUsd: 1, since } });
  expect(refused).toMatchObject({ refused: { limit: "account", spent: 0.25, held: 0.75 } });
  expect(isAccountBudgetRefusal(new BudgetRefusedError((refused as { refused: never }).refused, "x"))).toBe(true);
  expect(isAccountBudgetRefusal(new BudgetRefusedError({ limit: "day", limitUsd: 1, spent: 1, held: 0 }, "x"))).toBe(false);
});
