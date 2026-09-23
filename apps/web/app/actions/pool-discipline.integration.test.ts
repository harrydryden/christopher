/**
 * A transaction never asks the pool for a second connection. The interface's pool is three
 * connections per instance; a transaction that holds one and waits for another deadlocks the
 * instance under load, until the connection timeout fails it with its row locks held. Against a
 * pool of one, every such action would wait out that timeout and fail; these must simply finish.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, subscribeToCompany, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { eq, sql } from "drizzle-orm";
import { DEFAULT_SETTINGS } from "@ava/core";
import { signInTestUser } from "@/test/auth";
import type { User } from "@ava/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;
let user: User;
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (session ? { value: session } : undefined) }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));

import { addCompanies, useDiscoveryCandidate } from "./companies";
import { setRoleStage } from "./applications";
import { decide } from "./decisions";
import { removeCatalogueSource } from "./admin";

beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_b";
  const migrator = createDb(url);
  await runMigrations(migrator.db);
  await migrator.pool.end();
  const client = createDb(url, { max: 1 });
  database = client.db;
  pool = client.pool;
  process.env.SESSION_SECRET = "integration-test-secret";
}, 120_000);
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  await database.execute(sql`truncate companies, tasks, decisions, applications, user_settings, users restart identity cascade`);
  ({ user, cookie: session } = await signInTestUser(database, process.env.SESSION_SECRET!, "one-connection@example.com", "member"));
  await database.insert(schema.userSettings).values({ userId: user.id, key: "gate", value: DEFAULT_SETTINGS.gate });
});

async function role() {
  const [company] = await database.insert(schema.companies).values({ name: "Acme", domain: "acme.example", homepageUrl: "https://acme.example" }).returning();
  await subscribeToCompany(database, user.id, company!.id);
  const [source] = await database.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://acme.example/jobs" }).returning();
  const [job] = await database.insert(schema.jobs).values({ companyId: company!.id, sourceId: source!.id, externalKey: "1", title: "Operations Manager", normalizedTitle: "operations manager", url: "https://acme.example/jobs/1" }).returning();
  await database.insert(schema.userJobs).values({ userId: user.id, jobId: job!.id, inTable: true });
  return { company: company!, source: source!, job: job! };
}

it("finishes a follower's discovery confirmation on the one connection its transaction holds", async () => {
  const [company] = await database.insert(schema.companies).values({ name: "Beta", domain: "beta.example", homepageUrl: "https://beta.example" }).returning();
  await subscribeToCompany(database, user.id, company!.id);
  const [run] = await database.insert(schema.discoveryRuns).values({ companyId: company!.id, status: "needs_confirmation", candidates: [{ spec: { type: "html", url: "https://beta.example/careers" } }] }).returning();
  await useDiscoveryCandidate(run!.id, 0);
  expect((await database.select().from(schema.careerSources).where(eq(schema.careerSources.companyId, company!.id))).map(row => row.status)).toEqual(["active"]);
}, 30_000);

it("records a withdrawal's skip, an undo and a follow's admissions inside their own transactions", async () => {
  const { job } = await role();
  const withdraw = new FormData();
  withdraw.set("status", "withdrawn");
  withdraw.set("appliedOn", "2026-09-03");
  expect(await setRoleStage(job.id, { ok: true }, withdraw)).toEqual({ ok: true });
  expect(await decide(job.id, null, "")).toEqual({ ok: true });

  // Following an already-scanned company admits its roles with the follower's settings, read on the same connection.
  const [other] = await database.insert(schema.companies).values({ name: "Gamma", domain: "gamma.example", homepageUrl: "https://gamma.example" }).returning();
  const [source] = await database.insert(schema.careerSources).values({ companyId: other!.id, type: "html", url: "https://gamma.example/jobs" }).returning();
  await database.insert(schema.jobs).values({ companyId: other!.id, sourceId: source!.id, externalKey: "1", title: "Operations Lead", normalizedTitle: "operations lead", url: "https://gamma.example/jobs/1" });
  const form = new FormData();
  form.set("urls", "https://gamma.example");
  await expect(addCompanies(form)).rejects.toThrow("redirect:/companies?added=0&followed=1");
  expect(await database.select().from(schema.userJobs).where(eq(schema.userJobs.userId, user.id))).toHaveLength(2);
}, 30_000);

it("retires a source on one connection", async () => {
  const { source } = await role();
  await database.update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, user.id));
  await removeCatalogueSource(source.id);
  expect((await database.select().from(schema.careerSources).where(eq(schema.careerSources.id, source.id)))[0]!.status).toBe("disabled");
}, 30_000);
