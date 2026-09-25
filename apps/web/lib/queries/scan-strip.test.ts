/**
 * The status strip's own reads: the last completed scan of a company this account follows, and how
 * many it follows. Scans are shared, so both are seen through the account's subscriptions.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@ava/db";
import { createTestDb } from "@/test/db";
import { runMigrations } from "@ava/db/migrate";
import { sql } from "drizzle-orm";
import { ensureTestUser } from "@/test/auth";
import type { User } from "@ava/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let user: User;
let other: User;
vi.mock("@/lib/db", () => ({ db: () => database }));

import { followingCount, lastCompletedScanAt } from "./scan-strip";

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
afterAll(async () => { await pool?.end(); });

beforeEach(async () => {
  await database.execute(sql`truncate companies, settings, users restart identity cascade`);
  user = await ensureTestUser(database, "strip@example.com", "member");
  other = await ensureTestUser(database, "strip-other@example.com", "member");
});

async function companyWithSource(domain: string) {
  const [company] = await database.insert(schema.companies).values({ name: domain, homepageUrl: `https://${domain}`, domain }).returning();
  const [source] = await database.insert(schema.careerSources).values({ companyId: company!.id, type: "greenhouse", url: `https://${domain}/careers` }).returning();
  return { company: company!, source: source! };
}

const follow = (userId: string, companyId: string, status: "active" | "paused" | "archived" = "active") =>
  database.insert(schema.companySubscriptions).values({ userId, companyId, status });

const scan = (sourceId: string, finishedAt: Date | null, status: "ok" | "partial" | "failed" = "ok") =>
  database.insert(schema.scans).values({ sourceId, startedAt: new Date((finishedAt ?? new Date()).getTime() - 60_000), finishedAt, status });

it("counts only active subscriptions", async () => {
  const a = await companyWithSource("a.example");
  const b = await companyWithSource("b.example");
  const c = await companyWithSource("c.example");
  await follow(user.id, a.company.id);
  await follow(user.id, b.company.id, "paused");
  await follow(user.id, c.company.id, "archived");
  await follow(other.id, c.company.id);
  expect(await followingCount(user.id)).toBe(1);
  expect(await followingCount(other.id)).toBe(1);
});

it("reads the latest finished, unfailed scan of a followed company", async () => {
  const followed = await companyWithSource("followed.example");
  const unfollowed = await companyWithSource("elsewhere.example");
  await follow(user.id, followed.company.id);
  expect(await lastCompletedScanAt(user.id)).toBeNull();

  await scan(followed.source.id, new Date("2026-09-10T05:30:00Z"));
  await scan(followed.source.id, new Date("2026-09-11T05:30:00Z"), "partial");
  // A later failure, a scan still running, and a newer scan of a company this account does not follow are none of them it.
  await scan(followed.source.id, new Date("2026-09-12T05:30:00Z"), "failed");
  await scan(followed.source.id, null);
  await scan(unfollowed.source.id, new Date("2026-09-13T05:30:00Z"));

  expect((await lastCompletedScanAt(user.id))?.toISOString()).toBe("2026-09-11T05:30:00.000Z");
  expect(await lastCompletedScanAt(other.id)).toBeNull();
});
