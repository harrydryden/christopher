import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb } from "./client";
import { runMigrations } from "./migrate";
import { careerSources, companies, companySubscriptions, jobs, users } from "./schema";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/col_test";
const migration = readFileSync(new URL("../drizzle/0061_discovery_and_description_recovery.sql", import.meta.url), "utf8")
  .split("--> statement-breakpoint").map(statement => statement.trim()).filter(Boolean);
const connection = createDb(DATABASE_URL, { max: 2 });
const db = connection.db;

beforeAll(async () => { await runMigrations(db); });
afterAll(async () => { await connection.pool.end(); });

it("backfills only actively followed sourceless companies and clears legacy false description successes, idempotently", async () => {
  await db.execute(sql`truncate users, companies, company_subscriptions, career_sources, discovery_runs, jobs, tasks restart identity cascade`);
  const [user] = await db.insert(users).values({ email: "recovery-migration@example.test" }).returning();
  const rows = await db.insert(companies).values([
    { name: "Due", domain: "due-recovery.test", homepageUrl: "https://due-recovery.test" },
    { name: "Paused", domain: "paused-recovery.test", homepageUrl: "https://paused-recovery.test", status: "paused" },
    { name: "No follower", domain: "unfollowed-recovery.test", homepageUrl: "https://unfollowed-recovery.test" },
    { name: "With source", domain: "source-recovery.test", homepageUrl: "https://source-recovery.test" },
  ]).returning();
  const [due, paused, unfollowed, withSource] = rows;
  await db.insert(companySubscriptions).values([
    { companyId: due!.id, userId: user!.id, status: "active" },
    { companyId: paused!.id, userId: user!.id, status: "paused" },
    { companyId: withSource!.id, userId: user!.id, status: "active" },
  ]);
  const [source] = await db.insert(careerSources).values({ companyId: withSource!.id, type: "html", url: "https://source-recovery.test/jobs" }).returning();
  const oldFetched = new Date("2026-09-01T12:00:00Z");
  const [job] = await db.insert(jobs).values({ companyId: withSource!.id, sourceId: source!.id,
    externalKey: "old-empty", title: "Engineer", normalizedTitle: "engineer", url: "https://source-recovery.test/jobs/1",
    descriptionFetchedAt: oldFetched }).returning();
  const [successfulJob] = await db.insert(jobs).values({ companyId: withSource!.id, sourceId: source!.id,
    externalKey: "with-text", title: "Designer", normalizedTitle: "designer", url: "https://source-recovery.test/jobs/2",
    descriptionText: "A complete role description.", descriptionFetchedAt: oldFetched }).returning();

  for (const statement of migration) await db.execute(sql.raw(statement));
  const first = await db.select().from(companies);
  expect(first.find(row => row.id === due!.id)).toMatchObject({ discoveryRecoveryState: "waiting", discoveryRecoveryAttempts: 0 });
  expect(first.find(row => row.id === due!.id)!.discoveryNextAttemptAt).not.toBeNull();
  expect(first.find(row => row.id === paused!.id)!.discoveryRecoveryState).toBe("idle");
  expect(first.find(row => row.id === unfollowed!.id)!.discoveryRecoveryState).toBe("idle");
  expect(first.find(row => row.id === withSource!.id)!.discoveryRecoveryState).toBe("idle");
  const [backfilled] = await db.select().from(jobs).where(eq(jobs.id, job!.id));
  expect(backfilled!.descriptionAttemptedAt).toEqual(oldFetched);
  expect(backfilled!.descriptionFetchedAt).toBeNull();
  const [successful] = await db.select().from(jobs).where(eq(jobs.id, successfulJob!.id));
  expect(successful!.descriptionFetchedAt).toEqual(oldFetched);
  expect(successful!.descriptionAttemptedAt).toBeNull();

  for (const statement of migration) await db.execute(sql.raw(statement));
  const [again] = await db.select().from(companies).where(eq(companies.id, due!.id));
  expect(again!.discoveryNextAttemptAt).toEqual(first.find(row => row.id === due!.id)!.discoveryNextAttemptAt);
  const [againJob] = await db.select().from(jobs).where(eq(jobs.id, job!.id));
  expect(againJob!.descriptionAttemptedAt).toEqual(oldFetched);
  expect(againJob!.descriptionFetchedAt).toBeNull();
});
