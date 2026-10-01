/** Synchronous subscription/settings re-evaluation must request counted Workday places durably. */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@ava/core";
import { eq, sql } from "drizzle-orm";
import { createDb, type Db } from "./client";
import { reevaluateGate } from "./gate";
import { locationRevisionFor } from "./location-enrichment";
import { runMigrations } from "./migrate";
import * as schema from "./schema";

const { db, pool } = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test", { max: 2 });
const now = new Date("2026-10-01T21:00:00Z");

beforeAll(() => runMigrations(db), 60_000);
beforeEach(() => db.execute(sql`truncate tasks, companies, users restart identity cascade`));
afterAll(() => pool.end());

async function seed() {
  const [user] = await db.insert(schema.users).values({ email: "location-gate@example.test" }).returning();
  const [company] = await db.insert(schema.companies).values({ name: "Workday", domain: "workday.example", homepageUrl: "https://workday.example" }).returning();
  const [source] = await db.insert(schema.careerSources).values({ companyId: company!.id, type: "workday",
    url: "https://workday.wd5.myworkdayjobs.com/Workday", atsSlug: "workday", atsSite: "workday.wd5.myworkdayjobs.com|Workday" }).returning();
  const [job] = await db.insert(schema.jobs).values({ companyId: company!.id, sourceId: source!.id,
    externalKey: "id:JR-0108691", title: "Operations Manager", normalizedTitle: "operations manager",
    url: "https://workday.wd5.myworkdayjobs.com/Workday/job/USA-GA-Atlanta/Operations-Manager_JR-0108691",
    locationLabel: "70 Locations", locationResolution: "pending" }).returning();
  return { user: user!, company: company!, source: source!, job: job! };
}

const settings = (locationTerms: string[]) => ({ ...DEFAULT_SETTINGS, gate: { ...DEFAULT_SETTINGS.gate,
  includeKeywords: ["operations"], locationTerms, includeRemote: true } });
const locationTasks = async () => (await db.select().from(schema.tasks)).filter((task) => task.type === "fetch_locations");

it("a new subscription queues one revision from an old null-revision row without admitting unknown geography", async () => {
  const { user, company, source, job } = await seed();
  await reevaluateGate(db, user.id, settings(["Boston"]), now);
  expect(await locationTasks()).toHaveLength(0);

  await db.insert(schema.companySubscriptions).values({ userId: user.id, companyId: company.id });
  await reevaluateGate(db, user.id, settings(["Boston"]), now, { companyId: company.id });
  const revision = locationRevisionFor({ sourceId: source.id, externalKey: job.externalKey, url: job.url,
    title: job.title, locationLabel: "70 Locations" }, now);
  expect((await db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id)))[0]!.locationRevision).toBe(revision);
  expect((await locationTasks()).map((task) => task.payload)).toEqual([{ jobId: job.id, locationRevision: revision }]);
  expect(await db.select().from(schema.userJobs)).toHaveLength(0);
  await reevaluateGate(db, user.id, settings(["Boston"]), now, { companyId: company.id });
  expect(await locationTasks()).toHaveLength(1);
});

it("a changed location filter requests enrichment through the same synchronous gate path", async () => {
  const { user, company, job } = await seed();
  await db.insert(schema.companySubscriptions).values({ userId: user.id, companyId: company.id });
  await reevaluateGate(db, user.id, settings([]), now);
  expect(await locationTasks()).toHaveLength(0);
  expect((await db.select().from(schema.userJobs))[0]).toMatchObject({ jobId: job.id, inTable: true });

  await db.transaction((tx) => reevaluateGate(tx as unknown as Db, user.id, settings(["Boston"]), now));
  expect(await locationTasks()).toHaveLength(1);
  expect((await db.select().from(schema.userJobs))[0]).toMatchObject({ jobId: job.id, inTable: false });
});

it("holds only an existing view backed by matching detail places while a newer count is unresolved", async () => {
  const { user, company, job } = await seed();
  await db.insert(schema.companySubscriptions).values({ userId: user.id, companyId: company.id });
  await db.update(schema.jobs).set({ location: "USA, MA, Boston", locations: ["USA, MA, Boston", "USA, GA, Atlanta"],
    locationResolution: "resolved", locationFetchedAt: now, locationRevision: "old-revision" })
    .where(eq(schema.jobs.id, job.id));
  await reevaluateGate(db, user.id, settings(["Boston"]), now);
  expect((await db.select().from(schema.userJobs))[0]).toMatchObject({ jobId: job.id, inTable: true, locationOk: true });

  await db.update(schema.jobs).set({ locationResolution: "pending", locationRevision: "new-revision" })
    .where(eq(schema.jobs.id, job.id));
  await reevaluateGate(db, user.id, settings(["Boston"]), now);
  expect((await db.select().from(schema.userJobs))[0]).toMatchObject({ jobId: job.id, inTable: true, locationOk: true });
  expect((await locationTasks()).map((task) => task.payload)).toContainEqual({ jobId: job.id, locationRevision: "new-revision" });

  const [late] = await db.insert(schema.users).values({ email: "late-location@example.test" }).returning();
  await db.insert(schema.companySubscriptions).values({ userId: late!.id, companyId: company.id });
  await reevaluateGate(db, late!.id, settings(["Boston"]), now);
  expect((await db.select().from(schema.userJobs)).filter((view) => view.userId === late!.id)).toHaveLength(0);

  await db.update(schema.jobs).set({ locationResolution: "unavailable" }).where(eq(schema.jobs.id, job.id));
  await reevaluateGate(db, user.id, settings(["Boston"]), now);
  expect((await db.select().from(schema.userJobs).where(eq(schema.userJobs.userId, user.id)))[0])
    .toMatchObject({ jobId: job.id, inTable: true, locationOk: true });
  await reevaluateGate(db, late!.id, settings(["Boston"]), now);
  expect((await db.select().from(schema.userJobs)).filter((view) => view.userId === late!.id)).toHaveLength(0);

  await reevaluateGate(db, user.id, settings(["UK"]), now);
  expect((await db.select().from(schema.userJobs).where(eq(schema.userJobs.userId, user.id)))[0])
    .toMatchObject({ jobId: job.id, inTable: false, locationOk: false });
});

it("does not preserve a legacy count or remote view without a completed detail observation", async () => {
  const { user, company, job } = await seed();
  await db.insert(schema.companySubscriptions).values({ userId: user.id, companyId: company.id });
  await db.update(schema.jobs).set({ remote: true }).where(eq(schema.jobs.id, job.id));
  await db.insert(schema.userJobs).values({ userId: user.id, jobId: job.id, inTable: true,
    locationOk: true, keywordMatched: true, excluded: false });
  await reevaluateGate(db, user.id, settings(["Boston"]), now);
  expect((await db.select().from(schema.userJobs))[0]).toMatchObject({ inTable: false, locationOk: false });
});
