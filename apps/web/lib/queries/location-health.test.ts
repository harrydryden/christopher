import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, subscribeToCompany, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { createTestDb } from "@/test/db";
import { ensureTestUser } from "@/test/auth";
import { sql } from "drizzle-orm";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
vi.mock("@/lib/db", () => ({ db: () => database }));
import { locationChecks } from "./location-health";

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
afterAll(() => pool.end());
beforeEach(async () => database.execute(sql`truncate companies, tasks, users restart identity cascade`));

it("counts only open Workday checks visible to the active follower and distinguishes work already queued", async () => {
  const member = await ensureTestUser(database, "location-member@example.com");
  const other = await ensureTestUser(database, "location-other@example.com");
  const [company] = await database.insert(schema.companies).values({ name: "Acme", domain: "acme.test", homepageUrl: "https://acme.test" }).returning();
  const [elsewhere] = await database.insert(schema.companies).values({ name: "Other", domain: "other.test", homepageUrl: "https://other.test" }).returning();
  await subscribeToCompany(database, member.id, company!.id);
  await subscribeToCompany(database, other.id, elsewhere!.id);
  const [source] = await database.insert(schema.careerSources).values({ companyId: company!.id, type: "workday", url: "https://acme.wd1.myworkdayjobs.com/External", status: "active" }).returning();
  const [otherSource] = await database.insert(schema.careerSources).values({ companyId: elsewhere!.id, type: "workday", url: "https://other.wd1.myworkdayjobs.com/External", status: "active" }).returning();
  const make = (sourceId: string, companyId: string, key: string, state: "pending" | "unavailable", extra: Partial<typeof schema.jobs.$inferInsert> = {}) => ({
    companyId, sourceId, externalKey: key, title: key, normalizedTitle: key, url: `https://example.test/${key}`,
    locationResolution: state, locationLabel: "2 Locations", locationRevision: `${key}-revision`, ...extra,
  });
  const [pending, failed] = await database.insert(schema.jobs).values([
    make(source!.id, company!.id, "Pending", "pending"),
    make(source!.id, company!.id, "Failed", "unavailable"),
    make(source!.id, company!.id, "Private", "unavailable", { shared: false, addedBy: other.id }),
    make(source!.id, company!.id, "Closed", "unavailable", { status: "closed" }),
    make(otherSource!.id, elsewhere!.id, "Elsewhere", "unavailable"),
  ]).returning();
  const nextAttemptAt = new Date(Date.now() + 3_600_000);
  await database.insert(schema.tasks).values({ type: "fetch_locations", payload: { jobId: pending!.id, locationRevision: pending!.locationRevision }, dedupeKey: `fetch_locations:${pending!.id}:${pending!.locationRevision}`, runAfter: nextAttemptAt });

  const checks = await locationChecks(member.id);
  expect(checks).toMatchObject({ total: 2, pending: 1, unavailable: 1 });
  expect(checks.rows.map(row => [row.jobId, row.taskActive])).toEqual([[failed!.id, false], [pending!.id, true]]);
  expect(checks.rows[1]).toMatchObject({ taskStatus: "queued", nextAttemptAt });
  expect((await locationChecks(other.id)).rows.map(row => row.title)).toEqual(["Elsewhere"]);
  expect((await locationChecks(member.id, company!.id, 1)).total).toBe(2);
});
