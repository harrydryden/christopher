import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createDb, schema, type Db } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { eq, sql } from "drizzle-orm";
import { discoveryRecoveryAfterFailure, settleAbandonedDiscovery } from "./discovery-recovery";
import { sweepDueCompanyLogos, sweepDueDiscoveryRecovery } from "./periodic-company-recovery";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/col_test";
const now = new Date("2026-10-11T12:00:00Z");
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  const connection = createDb(DATABASE_URL, { max: 2 });
  db = connection.db;
  close = () => connection.pool.end();
  await runMigrations(db);
});
afterAll(async () => { await close?.(); });
beforeEach(async () => {
  await db.execute(sql`truncate users, companies, company_subscriptions, career_sources, discovery_runs, jobs, tasks restart identity cascade`);
});

async function company(domain: string, options: { followed?: boolean; state?: "waiting" | "manual_required"; due?: Date } = {}) {
  const [row] = await db.insert(schema.companies).values({
    name: domain, domain, homepageUrl: `https://${domain}`,
    discoveryRecoveryState: options.state ?? "waiting", discoveryNextAttemptAt: options.due ?? now,
  }).returning();
  if (options.followed) {
    const [user] = await db.insert(schema.users).values({ email: `${domain}@example.test` }).returning();
    await db.insert(schema.companySubscriptions).values({ companyId: row!.id, userId: user!.id, status: "active" });
  }
  return row!;
}

it("spaces three automatic retries, then requires a person", () => {
  expect(discoveryRecoveryAfterFailure(0, now).discoveryNextAttemptAt).toEqual(new Date(now.getTime() + 86_400_000));
  expect(discoveryRecoveryAfterFailure(1, now).discoveryNextAttemptAt).toEqual(new Date(now.getTime() + 3 * 86_400_000));
  expect(discoveryRecoveryAfterFailure(2, now).discoveryNextAttemptAt).toEqual(new Date(now.getTime() + 7 * 86_400_000));
  expect(discoveryRecoveryAfterFailure(3, now)).toEqual({ discoveryRecoveryState: "manual_required", discoveryNextAttemptAt: null });
});

it("claims only due active followed sourceless companies and never repeats a queued recovery", async () => {
  const eligible = await company("eligible.test", { followed: true });
  await company("unfollowed.test");
  await company("later.test", { followed: true, due: new Date(now.getTime() + 3600_000) });
  const blocked = await company("blocked.test", { followed: true });
  await db.insert(schema.careerSources).values({ companyId: blocked.id, type: "html", url: "https://blocked.test/jobs", status: "disabled" });
  const terminal = await company("terminal.test", { followed: true, state: "manual_required" });
  expect(await sweepDueDiscoveryRecovery(db, now)).toBe(1);
  expect(await sweepDueDiscoveryRecovery(db, now)).toBe(0);
  const [updated] = await db.select().from(schema.companies).where(eq(schema.companies.id, eligible.id));
  expect(updated).toMatchObject({ discoveryRecoveryAttempts: 1, discoveryRecoveryState: "idle", discoveryNextAttemptAt: null });
  expect((await db.select().from(schema.tasks).where(eq(schema.tasks.type, "discover"))).map(task => task.payload)).toEqual([
    { companyId: eligible.id, homepageUrl: eligible.homepageUrl, reason: "recovery" },
  ]);
  expect((await db.select().from(schema.companies).where(eq(schema.companies.id, terminal.id)))[0]!.discoveryRecoveryState).toBe("manual_required");
});

it("does not let an abandoned old-homepage task arm recovery after an administrator corrects it", async () => {
  const row = await company("old-home.test", { followed: true });
  await db.update(schema.companies).set({ discoveryRecoveryState: "idle", discoveryNextAttemptAt: null,
    homepageUrl: "https://corrected.test" }).where(eq(schema.companies.id, row.id));
  const taskId = "00000000-0000-4000-8000-000000000009";
  await db.insert(schema.discoveryRuns).values({ companyId: row.id, taskId,
    homepageUrl: row.homepageUrl, status: "failed", startedAt: now });
  await settleAbandonedDiscovery(db, row.id, taskId, new Date(now.getTime() - 1000), false, now);
  const [unchanged] = await db.select().from(schema.companies).where(eq(schema.companies.id, row.id));
  expect(unchanged).toMatchObject({ discoveryRecoveryState: "idle", discoveryNextAttemptAt: null });
});

it("arms a final failed discovery only once", async () => {
  const row = await company("abandoned.test", { followed: true });
  await db.update(schema.companies).set({ discoveryRecoveryState: "idle", discoveryNextAttemptAt: null })
    .where(eq(schema.companies.id, row.id));
  const taskId = "00000000-0000-4000-8000-000000000010";
  await db.insert(schema.discoveryRuns).values({ companyId: row.id, taskId,
    homepageUrl: row.homepageUrl, status: "failed", startedAt: now });
  await settleAbandonedDiscovery(db, row.id, taskId, new Date(now.getTime() - 1000), false, now);
  const [first] = await db.select().from(schema.companies).where(eq(schema.companies.id, row.id));
  expect(first!.discoveryRecoveryState).toBe("waiting");
  await settleAbandonedDiscovery(db, row.id, taskId, new Date(now.getTime() - 1000), false,
    new Date(now.getTime() + 86_400_000));
  const [second] = await db.select().from(schema.companies).where(eq(schema.companies.id, row.id));
  expect(second!.discoveryNextAttemptAt).toEqual(first!.discoveryNextAttemptAt);
});

it("retries a failed logo refresh once its backoff ends despite a fresh stored logo", async () => {
  const row = await company("logo.test", { followed: true });
  await db.update(schema.companies).set({
    logoFetchedAt: new Date(now.getTime() - 3600_000), logoAttempts: 1,
    logoNextAttemptAt: new Date(now.getTime() - 1000), logoError: "temporarily unavailable",
  }).where(eq(schema.companies.id, row.id));
  expect(await sweepDueCompanyLogos(db, now)).toBe(1);
  expect(await sweepDueCompanyLogos(db, now)).toBe(0);
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.type, "discover"));
  expect(task?.payload).toMatchObject({ companyId: row.id, logoOnly: true, reason: "logo_sweep" });
});

it("does not sweep logos for paused-only or unfollowed catalogue rows", async () => {
  await company("nobody.test");
  const paused = await company("paused.test", { followed: true });
  await db.update(schema.companySubscriptions).set({ status: "paused" })
    .where(eq(schema.companySubscriptions.companyId, paused.id));
  await db.update(schema.companies).set({ status: "paused" }).where(eq(schema.companies.id, paused.id));
  expect(await sweepDueCompanyLogos(db, now)).toBe(0);
});

it("keeps the periodic logo sweep within 200 newly queued tasks per UTC day", async () => {
  const sweepAt = new Date();
  const first = await company("first.test", { followed: true });
  await company("second.test", { followed: true });
  await db.insert(schema.tasks).values(Array.from({ length: 199 }, (_, index) => ({
    type: "discover" as const, payload: { companyId: first.id, logoOnly: true, homepageUrl: "https://old.test", reason: "logo_sweep", index },
    status: "done" as const, createdAt: sweepAt, dedupeKey: null,
  })));
  expect(await sweepDueCompanyLogos(db, sweepAt)).toBe(1);
  expect(await sweepDueCompanyLogos(db, sweepAt)).toBe(0);
  const [count] = await db.execute<{ n: number }>(sql`select count(*)::int as n from tasks where type = 'discover'
    and payload->>'reason' = 'logo_sweep'` ).then(r => r.rows);
  expect(count?.n).toBe(200);
});
