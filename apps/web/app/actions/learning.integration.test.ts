/**
 * Learning's form actions, against the database. The page binds them straight to its forms, so an
 * expected refusal — a page left open while the worker wrote a new profile version, an empty or
 * overlong answer — comes back to the page as a sentence rather than as a crash page.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@col/db";
import { createTestDb, TEST_DATABASE_URL } from "@/test/db";
import { runMigrations } from "@col/db/migrate";
import { sql } from "drizzle-orm";
import { signInTestUser } from "@/test/auth";
import type { User } from "@col/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;
let user: User;
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (session ? { value: session } : undefined) }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));

import { revalidatePath } from "next/cache";
import { acceptFilterSuggestion, acceptFilterSuggestionWithReport, answerOpenQuestion, answerOpenQuestionSetting, rejectFilterSuggestion, savePinnedStatements, savePinnedStatementsSetting, savePreferenceProfile, savePreferenceProfileSetting, saveSeedProfile, saveSeedProfileSetting } from "./learning";

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
  const stale = "Your preference profile changed since this page loaded. Your edits are still here. Open the latest profile in a new tab, compare it with this draft and copy across the changes you want to keep.";
  await expect(savePinnedStatements(form({ pinnedStatements: "No relocation.", profileVersion: "1" }))).rejects.toThrow(refusal(stale));
  await expect(savePreferenceProfile(form({ markdown: "Strategy", profileVersion: "1" }))).rejects.toThrow(refusal(stale));
  await expect(answerOpenQuestion("q1", form({ answer: "Yes", profileVersion: "1" }))).rejects.toThrow(refusal(stale));
  expect(await versions()).toEqual([1, 2]);
  expect(await database.select().from(schema.tasks)).toHaveLength(0);
});

it("returns editable Learning refusals inline with an explicit new-tab recovery", async () => {
  await profileWithQuestion();
  await database.insert(schema.preferenceProfiles).values({ userId: user.id, version: 2, markdown: "Newer profile", pinnedStatements: [], openQuestions: [{ id: "q1", question: "Is remote work essential?" }], sourceDecisionCount: 4, model: "test" });
  const stale = { ok: false, error: expect.stringContaining("Your edits are still here"), recovery: { href: "/learning", label: "Check the latest profile in a new tab" } };
  expect(await savePreferenceProfileSetting({ ok: true }, form({ markdown: "My draft", profileVersion: "1" }))).toEqual(stale);
  expect(await savePinnedStatementsSetting({ ok: true }, form({ pinnedStatements: "My draft", profileVersion: "1" }))).toEqual(stale);
  expect(await answerOpenQuestionSetting("q1", { ok: true }, form({ answer: "My draft", profileVersion: "1" }))).toEqual(stale);
  expect(await savePreferenceProfileSetting({ ok: true }, form({ markdown: "My draft" }))).toEqual(stale);
  expect(await answerOpenQuestionSetting("q1", { ok: true }, form({ answer: " " , profileVersion: "2" }))).toEqual({ ok: false, error: "Write an answer before saving it." });
  expect(await saveSeedProfileSetting({ ok: true }, form({ seedProfile: "z".repeat(5_001) }))).toEqual({ ok: false, error: "Keep your seed profile under 5,000 characters. A few sentences is plenty." });
  expect(await versions()).toEqual([1, 2]);
  expect(await database.select().from(schema.tasks)).toHaveLength(0);
});

it("guards starting preferences shared by Learning and Settings against stale or missing snapshots", async () => {
  const first = await saveSeedProfileSetting({ ok: true }, form({ seedProfile: "Remote operations", expectedSeedProfile: "" }));
  expect(first).toEqual({ ok: true, nextSnapshot: { expectedSeedProfile: "Remote operations" } });
  const stale = { ok: false, error: expect.stringContaining("Your edits are still here"),
    recovery: { href: "/learning", label: "Check the latest preferences in a new tab" } };
  expect(await saveSeedProfileSetting({ ok: true }, form({ seedProfile: "London only", expectedSeedProfile: "" }))).toEqual(stale);
  expect(await saveSeedProfileSetting({ ok: true }, form({ seedProfile: "London only" }))).toEqual(stale);
  const [stored] = await database.select().from(schema.userSettings).where(sql`user_id = ${user.id} and key = 'seedProfile'`);
  expect(stored!.value).toBe("Remote operations");
  const beforeNoop = await database.select().from(schema.tasks);
  expect(await saveSeedProfileSetting({ ok: true }, form({ seedProfile: "Remote operations", expectedSeedProfile: "Remote operations" })))
    .toEqual({ ok: true, nextSnapshot: { expectedSeedProfile: "Remote operations" } });
  expect(await database.select().from(schema.tasks)).toEqual(beforeNoop);
  expect(await saveSeedProfileSetting({ ok: true }, form({ seedProfile: "London only", expectedSeedProfile: "Remote operations" })))
    .toEqual({ ok: true, nextSnapshot: { expectedSeedProfile: "London only" } });
});

it("serialises two starting-preferences saves from the same snapshot", async () => {
  const holder = await pool.connect();
  const observer = createTestDb({ max: 1 });
  let saves: Promise<Awaited<ReturnType<typeof saveSeedProfileSetting>>[]> | null = null;
  let results: Awaited<ReturnType<typeof saveSeedProfileSetting>>[];
  try {
    await holder.query("begin");
    await holder.query("select pg_advisory_xact_lock(874302, hashtext($1))", [user.id]);
    saves = Promise.all([
      saveSeedProfileSetting({ ok: true }, form({ seedProfile: "Remote operations", expectedSeedProfile: "" })),
      saveSeedProfileSetting({ ok: true }, form({ seedProfile: "London leadership", expectedSeedProfile: "" })),
    ]);
    const deadline = Date.now() + 5_000;
    let waiters = 0;
    while (Date.now() < deadline) {
      const activity = await observer.db.execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and query like '%pg_advisory_xact_lock%'`);
      waiters = Number(activity.rows[0]?.n ?? 0);
      if (waiters >= 2) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(waiters).toBeGreaterThanOrEqual(2);
    await holder.query("commit");
    results = await saves;
  } finally {
    await holder.query("rollback").catch(() => {});
    holder.release();
    await observer.pool.end();
    if (saves) await saves.catch(() => {});
  }
  expect(results.filter(result => result.ok)).toHaveLength(1);
  expect(results.filter(result => !result.ok)).toHaveLength(1);
  const [stored] = await database.select().from(schema.userSettings).where(sql`user_id = ${user.id} and key = 'seedProfile'`);
  expect(["Remote operations", "London leadership"]).toContain(stored!.value);
  expect((await database.select().from(schema.tasks)).map(task => task.type).sort()).toEqual(["rescore_all", "synthesize_profile"]);
});

it("rolls back a starting-preferences write if required follow-up work cannot be queued", async () => {
  await database.execute(sql.raw("create function learning_recovery_reject_synthesis() returns trigger language plpgsql as $$ begin if new.type = 'synthesize_profile' then raise exception 'forced queue failure'; end if; return new; end $$"));
  await database.execute(sql.raw("create trigger learning_recovery_reject_synthesis before insert on tasks for each row execute function learning_recovery_reject_synthesis()"));
  try {
    await expect(saveSeedProfileSetting({ ok: true }, form({ seedProfile: "Remote operations", expectedSeedProfile: "" }))).rejects.toThrow("Failed query");
    expect(await database.select().from(schema.userSettings).where(sql`user_id = ${user.id} and key = 'seedProfile'`)).toEqual([]);
    expect(await database.select().from(schema.tasks)).toHaveLength(0);
  } finally {
    await database.execute(sql.raw("drop trigger learning_recovery_reject_synthesis on tasks"));
    await database.execute(sql.raw("drop function learning_recovery_reject_synthesis()"));
  }
});

it("rolls back pinned statements and answers if their required synthesis cannot be queued", async () => {
  await profileWithQuestion();
  await database.execute(sql.raw("create function learning_recovery_reject_synthesis() returns trigger language plpgsql as $$ begin if new.type = 'synthesize_profile' then raise exception 'forced queue failure'; end if; return new; end $$"));
  await database.execute(sql.raw("create trigger learning_recovery_reject_synthesis before insert on tasks for each row execute function learning_recovery_reject_synthesis()"));
  try {
    await expect(savePinnedStatementsSetting({ ok: true }, form({ pinnedStatements: "Keep this", profileVersion: "1" }))).rejects.toThrow("Failed query");
    await expect(answerOpenQuestionSetting("q1", { ok: true }, form({ answer: "Yes", profileVersion: "1" }))).rejects.toThrow("Failed query");
    expect(await versions()).toEqual([1]);
    expect(await database.select().from(schema.tasks)).toHaveLength(0);
  } finally {
    await database.execute(sql.raw("drop trigger learning_recovery_reject_synthesis on tasks"));
    await database.execute(sql.raw("drop function learning_recovery_reject_synthesis()"));
  }
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
  expect(await answerOpenQuestionSetting("q1", { ok: true }, form({ answer: "A second answer", profileVersion: "2" }))).toMatchObject({
    ok: false, error: expect.stringContaining("Your preference profile changed"),
  });
  expect(await versions()).toEqual([1, 2]);
});

it("says so when a filter suggestion was already settled, instead of doing nothing", async () => {
  const [suggestion] = await database.insert(schema.filterSuggestions)
    .values({ userId: user.id, type: "keyword_include", value: { term: "strategy" }, rationale: "", status: "rejected" }).returning();
  await expect(acceptFilterSuggestion(suggestion!.id)).rejects.toThrow(refusal("That suggestion has already been settled."));
});

it("does not let a suggestion silently activate default filters for an unconfigured account", async () => {
  const [suggestion] = await database.insert(schema.filterSuggestions)
    .values({ userId: user.id, type: "keyword_include", value: { term: "strategy" }, rationale: "" }).returning();
  expect(await acceptFilterSuggestionWithReport(suggestion!.id)).toEqual({ ok: false, error: expect.stringContaining("Choose your keywords and locations") });
  expect(await database.select().from(schema.userSettings)).toHaveLength(0);
  expect((await database.select().from(schema.filterSuggestions))[0]!.status).toBe("pending");
});

it("revalidates the Roles page whenever the strip above its table settles a suggestion", async () => {
  await database.insert(schema.userSettings).values({ userId: user.id, key: "gate", value: {
    includeKeywords: ["operations"], seniorityKeywords: [], excludeKeywords: [], locationTerms: [], includeRemote: true, matchFields: ["title"],
  } });
  // The strip relies on the action's own response to carry the re-rendered Roles page, which
  // Next sends only when the action revalidates.
  const revalidated = vi.mocked(revalidatePath);
  const suggest = async (type: "keyword_include" | "hide_threshold", value: Record<string, unknown>) =>
    (await database.insert(schema.filterSuggestions).values({ userId: user.id, type, value, rationale: "" }).returning())[0]!;

  for (const suggestion of [await suggest("keyword_include", { term: "strategy" }), await suggest("hide_threshold", { threshold: 40 })]) {
    revalidated.mockClear();
    expect((await acceptFilterSuggestionWithReport(suggestion.id)).ok).toBe(true);
    expect(revalidated).toHaveBeenCalledWith("/");
  }

  const dismissed = await suggest("keyword_include", { term: "partnerships" });
  revalidated.mockClear();
  await rejectFilterSuggestion(dismissed.id);
  expect(revalidated.mock.calls).toEqual([["/learning"], ["/"]]);
});

it("merges simultaneous accepted terms under the settings lock and never rejects one afterwards", async () => {
  await database.insert(schema.userSettings).values({ userId: user.id, key: "gate", value: {
    includeKeywords: ["operations"], seniorityKeywords: [], excludeKeywords: [], locationTerms: [], includeRemote: true, matchFields: ["title"],
  } });
  const suggestions = await database.insert(schema.filterSuggestions).values([
    { userId: user.id, type: "keyword_include", value: { term: "strategy" }, rationale: "" },
    { userId: user.id, type: "keyword_include", value: { term: "finance" }, rationale: "" },
  ]).returning();
  const observer = createDb(TEST_DATABASE_URL, { max: 1 });
  const holder = await pool.connect();
  let accepted: Promise<Awaited<ReturnType<typeof acceptFilterSuggestionWithReport>>[]> | null = null;
  try {
    await holder.query("begin");
    await holder.query("select pg_advisory_xact_lock(hashtext($1))", [`settings:${user.id}`]);
    accepted = Promise.all(suggestions.map(row => acceptFilterSuggestionWithReport(row.id)));
    // Wait until both requests have reached the same lock. The old implementation read the gate
    // before reaching it, so this interleaving used to overwrite one accepted term.
    const deadline = Date.now() + 5_000;
    let waiters = 0;
    while (Date.now() < deadline) {
      const result = await observer.db.execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and query like '%pg_advisory_xact_lock%'`);
      waiters = Number(result.rows[0]?.n ?? 0);
      if (waiters >= 2) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(waiters).toBeGreaterThanOrEqual(2);
    await holder.query("commit");
    expect((await accepted).map(result => result.ok)).toEqual([true, true]);
  } finally {
    await holder.query("rollback").catch(() => {});
    holder.release();
    await observer.pool.end();
    if (accepted) await accepted.catch(() => {});
  }
  const [gate] = await database.select().from(schema.userSettings)
    .where(sql`user_id = ${user.id} and key = 'gate'`);
  expect([...(gate!.value as { includeKeywords: string[] }).includeKeywords].sort()).toEqual(["finance", "operations", "strategy"]);
  await rejectFilterSuggestion(suggestions[0]!.id);
  expect((await database.select({ status: schema.filterSuggestions.status }).from(schema.filterSuggestions)
    .where(sql`id = ${suggestions[0]!.id}`))[0]!.status).toBe("accepted");
});
