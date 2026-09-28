/**
 * Per-account gate re-evaluation: the lease is one account's, and the description text is read
 * only by a gate that matches on it.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createDb, reevaluateGate, schema, viewUpdate, viewVerdict, writeViewUpdates, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { sql } from "drizzle-orm";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { handleReevaluateGate } from "./handlers/learning";
import { LeaseBusyError } from "./lease";
import { ensureTestUser } from "./test-users";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test";

let deps: WorkerDeps;
let db: Db;
const now = new Date("2026-09-18T09:00:00Z");

beforeAll(async () => {
  const bootstrap = createDb(DATABASE_URL, { max: 1 });
  await runMigrations(bootstrap.db);
  await bootstrap.pool.end();
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.AVA_DISABLE_BROWSER = "1";
  deps = await createDeps(readEnv(), { now: () => now, settingsTtlMs: 0 });
  db = deps.db;
}, 60_000);

afterAll(async () => { await deps?.close(); });

beforeEach(async () => {
  await db.execute(sql`truncate tasks, companies, career_sources, jobs, resource_leases, settings, user_settings, company_subscriptions, user_jobs restart identity cascade`);
});

const task = (payload: Record<string, unknown>) => ({ id: "00000000-0000-0000-0000-000000000000", type: "reevaluate_gate", payload, attempts: 1 } as never);

async function setGate(userId: string, gate: Record<string, unknown>) {
  const value = { includeKeywords: ["operations"], excludeKeywords: [], matchFields: ["title"], locationTerms: [], includeRemote: true, ...gate };
  await db.insert(schema.userSettings).values({ userId, key: "gate", value })
    .onConflictDoUpdate({ target: [schema.userSettings.userId, schema.userSettings.key], set: { value } });
  deps.invalidateSettings();
}

/** One company the account follows, with one posting whose description carries the keyword. */
async function seedFollowedPosting(userId: string) {
  const [company] = await db.insert(schema.companies).values({ name: "Acme", domain: "acme.test", homepageUrl: "https://acme.test" }).returning();
  await db.insert(schema.companySubscriptions).values({ userId, companyId: company!.id, status: "active" });
  const [source] = await db.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://acme.test/jobs" }).returning();
  const [job] = await db.insert(schema.jobs).values({
    companyId: company!.id, sourceId: source!.id, externalKey: "id:1", title: "Warehouse Lead",
    normalizedTitle: "warehouse lead", url: "https://acme.test/jobs/1", location: "London",
    locations: ["London"], descriptionText: "You will run operations across the site.",
  }).returning();
  return { company: company!, job: job! };
}

it("leases each account separately, so one account's re-evaluation never blocks another's", async () => {
  const held = await ensureTestUser(db, "gate-held@example.com");
  const free = await ensureTestUser(db, "gate-free@example.com", "member");
  await setGate(held.id, {});
  await setGate(free.id, {});
  // Someone else is already re-evaluating the first account.
  await db.execute(sql`insert into resource_leases (key, owner, expires_at)
    values (${`reevaluate-gate:${held.id}`}, gen_random_uuid(), now() + interval '5 minutes')`);

  // The other account runs regardless: before, one global lease made this fail busy and retry.
  const outcome = await handleReevaluateGate(task({ userId: free.id }), deps) as { accounts: number };
  expect(outcome.accounts).toBe(1);
  await expect(handleReevaluateGate(task({ userId: held.id }), deps)).rejects.toBeInstanceOf(LeaseBusyError);

  // And the lease it took for itself is released again.
  const left = await db.execute<{ key: string }>(sql`select key from resource_leases`);
  expect(left.rows.map(r => r.key)).toEqual([`reevaluate-gate:${held.id}`]);
});

it("admits a role on its description only when the account's gate matches on descriptions", async () => {
  const user = await ensureTestUser(db, "gate-fields@example.com", "member");
  const { job } = await seedFollowedPosting(user.id);

  await setGate(user.id, { matchFields: ["title"] });
  await handleReevaluateGate(task({ userId: user.id }), deps);
  expect(await db.select().from(schema.userJobs)).toHaveLength(0);

  await setGate(user.id, { matchFields: ["title", "description"] });
  await handleReevaluateGate(task({ userId: user.id }), deps);
  const views = await db.select().from(schema.userJobs);
  expect(views.map(v => [v.jobId, v.inTable])).toEqual([[job.id, true]]);
});

it("runs every page and the closing archive through the caller's eachPage, each in its own transaction", async () => {
  const user = await ensureTestUser(db, "gate-pages@example.com", "member");
  const { company, job } = await seedFollowedPosting(user.id);
  const [source] = await db.select().from(schema.careerSources);
  // 300 more roles: two pages of 250, then the empty read that ends the walk.
  await db.insert(schema.jobs).values(Array.from({ length: 300 }, (_, n) => ({
    companyId: company.id, sourceId: source!.id, externalKey: `id:page-${n}`, title: `Operations Analyst ${n}`,
    normalizedTitle: `operations analyst ${n}`, url: `https://acme.test/jobs/page-${n}`,
  })));
  await setGate(user.id, {});
  const settings = await deps.userSettings(user.id);

  const handles: unknown[] = [];
  const outcome = await reevaluateGate(db, user.id, settings, now, {}, {
    eachPage: work => db.transaction(tx => { handles.push(tx); return work(tx as unknown as Db); }),
  });
  // Three page reads (250, 51, none) and the archive: four short transactions, not one long one.
  expect(handles).toHaveLength(4);
  expect(new Set(handles).size).toBe(4);
  expect(outcome).toMatchObject({ examined: 301, created: 300 });
  expect(await db.select().from(schema.userJobs)).toHaveLength(300);

  // Narrowed: the pages write through the same hook and the archive puts the lot away.
  await setGate(user.id, { includeKeywords: ["no-match"] });
  const narrowed = await reevaluateGate(db, user.id, await deps.userSettings(user.id), now, {}, { eachPage: work => db.transaction(tx => work(tx as unknown as Db)) });
  expect(narrowed.archived).toBe(300);
  expect((await db.select().from(schema.userJobs)).every(v => v.archivedAt !== null && v.jobId !== job.id)).toBe(true);
});

it("analyses user_jobs after a re-evaluation that writes over five hundred views, and not after a small one", async () => {
  const user = await ensureTestUser(db, "gate-analyse@example.com", "member");
  await setGate(user.id, {});
  const { company } = await seedFollowedPosting(user.id);
  const [source] = await db.select().from(schema.careerSources).where(sql`${schema.careerSources.companyId} = ${company.id}`);
  const lastAnalyse = async () => (await db.execute<{ at: string | null }>(sql`select last_analyze::text as at from pg_stat_user_tables where relname = 'user_jobs'`)).rows[0]!.at;

  const small = await handleReevaluateGate(task({ userId: user.id }), deps) as { analysed?: boolean };
  expect(small.analysed).toBeUndefined();

  await db.insert(schema.jobs).values(Array.from({ length: 510 }, (_, i) => ({
    companyId: company.id, sourceId: source!.id, externalKey: `id:bulk-${i}`, title: `Operations Manager ${i}`,
    normalizedTitle: `operations manager ${i}`, url: `https://acme.test/jobs/bulk-${i}`, location: "London", locations: ["London"],
  })));
  const before = await lastAnalyse();
  const bulk = await handleReevaluateGate(task({ userId: user.id }), deps) as { analysed?: boolean; outcomes: Record<string, { created: number }> };
  expect(bulk.outcomes[user.id]!.created).toBeGreaterThan(500);
  expect(bulk.analysed).toBe(true);
  // The statistics view is updated asynchronously; the manual analyse is what it records.
  for (let i = 0; i < 30 && (await lastAnalyse()) === before; i++) await new Promise(r => setTimeout(r, 100));
  expect(await lastAnalyse()).not.toBe(before);
});

it("writes one view writer's columns as each caller asks: hidden only when given, near-miss always cleared", async () => {
  const user = await ensureTestUser(db, "gate-writer@example.com");
  const { job } = await seedFollowedPosting(user.id);
  // A legacy row: hidden and a near miss, both set by code long since retired.
  await db.insert(schema.userJobs).values({ userId: user.id, jobId: job.id, inTable: false, hidden: true, nearMiss: true });
  const read = async () => (await db.select().from(schema.userJobs).where(sql`user_id = ${user.id} and job_id = ${job.id}`))[0]!;
  const verdict = { keywordMatched: true, keywordTerms: ["operations"], excluded: false, excludedTerms: [], locationOk: true, locationTerms: [], remote: false, inTable: true };

  // A scan's values carry no `hidden`, and the legacy near miss alone is reason to write.
  const scanValues = viewVerdict(verdict, false);
  const view = { ...(await read()), keywordMatched: true, keywordTerms: ["operations"] };
  const scanUpdate = viewUpdate(user.id, job.id, view, scanValues);
  expect(scanUpdate).toMatchObject({ restore: false });
  expect(scanUpdate).not.toHaveProperty("hidden");
  // Without the near-miss column read (the gate walk), the same agreeing view needs no write.
  expect(viewUpdate(user.id, job.id, { ...view, nearMiss: undefined }, scanValues)).toBeNull();
  await writeViewUpdates(db, [scanUpdate!], now);
  expect(await read()).toMatchObject({ keywordMatched: true, inTable: false, hidden: true, nearMiss: false });

  // The description and gate paths pass `hidden: false`, which the write then sets.
  const shown = viewUpdate(user.id, job.id, await read(), viewVerdict(verdict, true, { hidden: false }));
  await writeViewUpdates(db, [shown!], now);
  expect(await read()).toMatchObject({ inTable: true, hidden: false });
  expect(viewUpdate(user.id, job.id, await read(), viewVerdict(verdict, true, { hidden: false }))).toBeNull();
});
