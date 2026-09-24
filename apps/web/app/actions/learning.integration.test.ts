/**
 * Learning's form actions, against the database. The page binds them straight to its forms, so an
 * expected refusal — a page left open while the worker wrote a new profile version, an empty or
 * overlong answer — comes back to the page as a sentence rather than as a crash page.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@ava/db";
import { createTestDb } from "@/test/db";
import { runMigrations } from "@ava/db/migrate";
import { sql } from "drizzle-orm";
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

import { acceptFilterSuggestion, answerOpenQuestion, savePinnedStatements, savePreferenceProfile, saveSeedProfile } from "./learning";

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = "integration-test-secret";
}, 120_000);
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  await database.execute(sql`truncate companies, tasks, preference_profiles, filter_suggestions, user_settings, users restart identity cascade`);
  ({ user, cookie: session } = await signInTestUser(database, process.env.SESSION_SECRET!, "learner@example.com", "member"));
});

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};
/** The page the action sends the person back to, with the sentence it shows. */
const refusal = (sentence: string) => `redirect:/learning?${new URLSearchParams({ error: sentence }).toString()}`;
const versions = async () => (await database.select().from(schema.preferenceProfiles)).map(row => row.version).sort();

async function profileWithQuestion() {
  await database.insert(schema.preferenceProfiles).values({
    userId: user.id, version: 1, markdown: "Operations leadership", pinnedStatements: [], openQuestions: [{ id: "q1", question: "Is remote work essential?" }], sourceDecisionCount: 4, model: "test",
  });
}

it("sends a save from a page opened before the worker wrote a new version back with a reason", async () => {
  await profileWithQuestion();
  // The worker synthesised version 2 while the page still showed version 1.
  await database.insert(schema.preferenceProfiles).values({ userId: user.id, version: 2, markdown: "Operations, remote", pinnedStatements: [], openQuestions: [{ id: "q1", question: "Is remote work essential?" }], sourceDecisionCount: 5, model: "test" });
  const stale = "Your preference profile changed since this page loaded, often because a new version was synthesised. Reload Learning and make the change again.";
  await expect(savePinnedStatements(form({ pinnedStatements: "No relocation.", profileVersion: "1" }))).rejects.toThrow(refusal(stale));
  await expect(savePreferenceProfile(form({ markdown: "Strategy", profileVersion: "1" }))).rejects.toThrow(refusal(stale));
  await expect(answerOpenQuestion("q1", form({ answer: "Yes", profileVersion: "1" }))).rejects.toThrow(refusal(stale));
  expect(await versions()).toEqual([1, 2]);
  expect(await database.select().from(schema.tasks)).toHaveLength(0);
});

it("refuses empty and overlong answers and pinned statements in a sentence, writing nothing", async () => {
  await profileWithQuestion();
  await expect(answerOpenQuestion("q1", form({ answer: "  ", profileVersion: "1" }))).rejects.toThrow(refusal("Write an answer before saving it."));
  await expect(answerOpenQuestion("q1", form({ answer: "x".repeat(2_001), profileVersion: "1" }))).rejects.toThrow(refusal("Keep an answer under 2,000 characters."));
  await expect(answerOpenQuestion("gone", form({ answer: "Yes", profileVersion: "1" }))).rejects.toThrow("redirect:/learning?error=");
  await expect(savePinnedStatements(form({ pinnedStatements: `Short.\n${"y".repeat(2_001)}`, profileVersion: "1" }))).rejects.toThrow(refusal("Keep each pinned statement under 2,000 characters."));
  await expect(savePinnedStatements(form({ pinnedStatements: Array.from({ length: 51 }, (_, n) => `Statement ${n}`).join("\n"), profileVersion: "1" }))).rejects.toThrow(refusal("Pin at most 50 statements."));
  await expect(saveSeedProfile(form({ seedProfile: "z".repeat(5_001) }))).rejects.toThrow(refusal("Keep your seed profile under 5,000 characters. A few sentences is plenty."));
  expect(await versions()).toEqual([1]);
  expect(await database.select().from(schema.tasks)).toHaveLength(0);

  // Within the limits, the same forms save.
  await answerOpenQuestion("q1", form({ answer: "x".repeat(2_000), profileVersion: "1" }));
  expect(await versions()).toEqual([1, 2]);
});

it("says so when a filter suggestion was already settled, instead of doing nothing", async () => {
  const [suggestion] = await database.insert(schema.filterSuggestions)
    .values({ userId: user.id, type: "keyword_include", value: { term: "strategy" }, rationale: "", status: "rejected" }).returning();
  await expect(acceptFilterSuggestion(suggestion!.id)).rejects.toThrow(refusal("That suggestion has already been settled."));
});
