/**
 * Model work waits for a confirmed address (CLAUDE.md: "work that scans, discovers or calls a model
 * goes through requireVerifiedUser()"), against the database.
 *
 * An unconfirmed member still sets filters and writes the seed profile at once — setup asks for
 * both first — but nothing they save queues a synthesis, a re-score or a source check until the
 * address is proven, and the actions whose whole point is model work send them to confirm it.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { eq, sql } from "drizzle-orm";
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

import { acceptFilterSuggestionWithReport, answerOpenQuestion, savePinnedStatements, savePreferenceProfile, saveSeedProfileSetting } from "./learning";
import { saveDecisionTags } from "./decisions";
import { rejectSuggestion } from "./suggestions";
import { updateDiscoverySource } from "./discovery-sources";
import { saveGate } from "./settings";

const VERIFY = "redirect:/account?verify=required";

beforeAll(async () => {
  const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_b");
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = "integration-test-secret";
}, 120_000);
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  await database.execute(sql`truncate companies, tasks, preference_profiles, user_settings, users restart identity cascade`);
  ({ user, cookie: session } = await signInTestUser(database, process.env.SESSION_SECRET!, "unconfirmed@example.com", "member"));
  await database.update(schema.users).set({ emailVerifiedAt: null }).where(eq(schema.users.id, user.id));
});

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};
const taskTypes = async () => (await database.select({ type: schema.tasks.type }).from(schema.tasks)).map(row => row.type).sort();

it("sends an unconfirmed member to confirm before any Learning or recommendation save that calls a model", async () => {
  const [profile] = await database.insert(schema.preferenceProfiles).values({
    userId: user.id, version: 1, markdown: "Operations", pinnedStatements: [], openQuestions: [{ id: "q1", question: "Remote?" }], sourceDecisionCount: 0, model: "user",
  }).returning();
  const [decision] = await database.insert(schema.decisions).values({ userId: user.id, decision: "skip", reason: "Too junior", jobTitle: "Ops", companyName: "Acme" }).returning();
  const [filter] = await database.insert(schema.filterSuggestions).values({ userId: user.id, type: "keyword_include", value: { term: "strategy" }, rationale: "" }).returning();
  const [company] = await database.insert(schema.companySuggestions).values({ userId: user.id, name: "Beta", homepageUrl: "https://beta.example", domain: "beta.example" }).returning();
  const [source] = await database.insert(schema.discoverySources).values({ userId: user.id, name: "Newsletter", kind: "email", enabled: false }).returning();

  await expect(savePinnedStatements(form({ pinnedStatements: "No relocation.", profileVersion: "1" }))).rejects.toThrow(VERIFY);
  await expect(answerOpenQuestion("q1", form({ answer: "Yes", profileVersion: "1" }))).rejects.toThrow(VERIFY);
  await expect(savePreferenceProfile(form({ markdown: "Strategy", profileVersion: "1" }))).rejects.toThrow(VERIFY);
  await expect(saveDecisionTags(decision!.id, form({}))).rejects.toThrow(VERIFY);
  await expect(acceptFilterSuggestionWithReport(filter!.id)).rejects.toThrow(VERIFY);
  await expect(rejectSuggestion(company!.id, form({ reason: "Wrong sector" }))).rejects.toThrow(VERIFY);
  await expect(updateDiscoverySource(source!.id, form({ intervalDays: "1", enabled: "on" }))).rejects.toThrow(VERIFY);

  expect(await taskTypes()).toEqual([]);
  expect((await database.select().from(schema.preferenceProfiles)).map(row => row.version)).toEqual([profile!.version]);
  expect((await database.select().from(schema.filterSuggestions))[0]!.status).toBe("pending");
  expect((await database.select().from(schema.companySuggestions))[0]!.status).toBe("pending");
  expect((await database.select().from(schema.discoverySources))[0]!.enabled).toBe(false);
});

it("saves filters and the seed profile at once, and queues their model work only once the address is confirmed", async () => {
  expect(await saveSeedProfileSetting({ ok: true }, form({ seedProfile: "Operations leadership in London." }))).toEqual({ ok: true });
  expect(await saveGate({ ok: true }, form({ includeKeywords: "operations", locationTerms: "London" }))).toEqual({ ok: true });
  const stored = await database.select({ key: schema.userSettings.key }).from(schema.userSettings).where(eq(schema.userSettings.userId, user.id));
  expect(stored.map(row => row.key).sort()).toEqual(["gate", "seedProfile"]);
  expect(await taskTypes()).toEqual([]);

  await database.update(schema.users).set({ emailVerifiedAt: new Date() }).where(eq(schema.users.id, user.id));
  expect(await saveSeedProfileSetting({ ok: true }, form({ seedProfile: "Operations leadership, UK." }))).toEqual({ ok: true });
  expect(await saveGate({ ok: true }, form({ includeKeywords: "operations, strategy", locationTerms: "London" }))).toEqual({ ok: true });
  expect(await taskTypes()).toEqual(["rescore_all", "synthesize_profile"]);
});
