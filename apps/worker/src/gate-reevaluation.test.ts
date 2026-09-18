/**
 * Per-account gate re-evaluation: the lease is one account's, and the description text is read
 * only by a gate that matches on it.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createDb, schema, type Db } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { sql } from "drizzle-orm";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { handleReevaluateGate } from "./handlers/learning";
import { LeaseBusyError } from "./lease";
import { ensureTestUser } from "./test-users";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test";

let deps: WorkerDeps;
let db: Db;
const now = new Date("2026-09-18T09:00:00Z");

beforeAll(async () => {
  const bootstrap = createDb(DATABASE_URL, { max: 1 });
  await runMigrations(bootstrap.db);
  await bootstrap.pool.end();
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.CHRISTOPHER_DISABLE_BROWSER = "1";
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
