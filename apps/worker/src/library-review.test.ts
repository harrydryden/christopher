/**
 * The `review_library` task, end to end against the database.
 *
 * It drives the real A12 engine through a scripted client rather than stubbing the engine,
 * because what matters here is the order of the pass and what it costs: the deterministic
 * baseline has to be on the page before the model is asked anything, an entry nobody touched must
 * not be sent again, and an account with nothing left to spend must finish done with a sentence
 * rather than fail and retry for ever.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createDb, schema, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import type { AiClientLike, ParseResponse } from "@ava/ai";
import { libraryEntryInputHash, setRowFacets, type CvLibrary } from "@ava/core";
import { desc, eq, sql } from "drizzle-orm";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { handleReviewLibrary } from "./handlers/library-review";
import { ensureTestUser } from "./test-users";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test";

let deps: WorkerDeps;
let db: Db;
let userId: string;
const now = new Date("2026-09-19T09:00:00Z");

const ROWS = {
  ran: "Ran the UK warehouse team of 30 through a move to a new site",
  cut: "Cut handover time from two days to four hours",
  led: "Led the carrier tender across four regions for the retail business",
  msc: "MSc Operations Management, University of Leeds, 2014",
};

function libraryOf(over: { first?: string } = {}): CvLibrary {
  return {
    name: "Test Candidate",
    contact: "London",
    profile: "Operations leader with delivery experience",
    employment: [
      { id: "job1", company: "Acme", jobTitle: "Director of Operations", startDate: "2020-01", endDate: "2022-01", current: false },
      { id: "job2", company: "Brisk", jobTitle: "Logistics Manager", startDate: "2016-01", endDate: "2019-12", current: false },
    ],
    entries: [
      { id: "role", kind: "experience", heading: "Director of Operations · Acme", employmentId: "job1",
        details: [over.first ?? ROWS.ran, ROWS.cut].join("\n") },
      { id: "later", kind: "experience", heading: "Logistics Manager · Brisk", employmentId: "job2", details: ROWS.led },
      // Education and skills are not reviewed: the rubric's marks are job-shaped.
      { id: "degree", kind: "education", heading: "University of Leeds", details: ROWS.msc },
      { id: "skills", kind: "skill", heading: "Skills", details: "Forecasting\nSQL" },
      // No rows at all: nothing to classify, so it is never sent and never scored.
      { id: "hobbies", kind: "interest", heading: "Interests", details: "Cycling" },
    ],
  };
}

async function saveLibrary(version: number, content: CvLibrary) {
  await db.insert(schema.cvLibraries).values({ userId, version, content, createdAt: now });
}

const USAGE = { input_tokens: 900, output_tokens: 300, cache_read_input_tokens: 2000, cache_creation_input_tokens: 400 };

/**
 * One batch, as the engine laid it out: which entries it asked about, every row it showed, and the
 * rows it asked to have classified — all of them, unless it named only some.
 */
function batchOf(params: Record<string, unknown>) {
  const blocks = (params.messages as Array<{ content: Array<{ text: string }> }>)[0]!.content;
  return blocks[1]!.text.split("\n\n").flatMap(chunk => {
    const id = chunk.match(/^Entry \[([^\]]+)\]/mu)?.[1];
    if (!id) return [];
    // Rows are numbered; the rows to classify, when only some, are named by number after them.
    const all = [...chunk.matchAll(/^(\d+)\. (.*)$/gmu)].map(match => ({ number: Number(match[1]), text: match[2]! }));
    const only = chunk.match(/^Classify only rows ([\d, ]+) \(/mu)?.[1]?.split(", ").map(Number);
    const none = /^Classify no rows/mu.test(chunk);
    const asked = none ? [] : only ? all.filter(row => only.includes(row.number)) : all;
    return [{ id, all: all.map(row => row.text), rows: asked.map(row => row.text), numbers: asked.map(row => row.number) }];
  });
}

/**
 * A client that classifies whatever it is sent, quoting each row verbatim, and reports what the
 * stored reviews looked like at the moment it was called. `omit` names entries it leaves out of
 * every answer.
 */
function scriptedClient({ omit = [] }: { omit?: string[] } = {}) {
  const calls: Array<{ entries: string[]; rows: string[]; baseline: Array<{ entryId: string; source: string; score: number }> }> = [];
  const client: AiClientLike = {
    messages: {
      async create(params): Promise<ParseResponse> {
        const batch = batchOf(params);
        const baseline = await db.select({ entryId: schema.cvLibraryReviews.entryId, source: schema.cvLibraryReviews.source, score: schema.cvLibraryReviews.score })
          .from(schema.cvLibraryReviews).orderBy(schema.cvLibraryReviews.entryId);
        calls.push({ entries: batch.map(entry => entry.id), rows: batch.flatMap(entry => entry.rows), baseline });
        return {
          parsed_output: {
            entries: batch.filter(entry => !omit.includes(entry.id)).map(entry => ({
              entryId: entry.id,
              rows: entry.rows.map((row, index) => ({
                row: entry.numbers[index]!, facets: index === 0 ? ["responsibility"] : ["outcome", "metric"],
                marks: index === 0 ? ["responsibility.scope", "responsibility.ownership"] : ["outcome.change", "metric.figure"], quote: row,
              })),
              prompts: ["What problem were you brought in to solve?"],
            })),
          },
          usage: USAGE,
          stop_reason: "end_turn",
          model: "claude-fable-5-1",
        };
      },
    },
  };
  return { client, calls };
}

const task = (payload: Record<string, unknown>) =>
  ({ id: "00000000-0000-0000-0000-000000000000", type: "review_library", payload, attempts: 1 } as never);

const reviews = async () => db.select().from(schema.cvLibraryReviews).orderBy(schema.cvLibraryReviews.entryId);

beforeAll(async () => {
  const bootstrap = createDb(DATABASE_URL, { max: 1 });
  await runMigrations(bootstrap.db);
  await bootstrap.pool.end();
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.AVA_DISABLE_BROWSER = "1";
  deps = await createDeps(readEnv(), { now: () => now, settingsTtlMs: 0 });
  db = deps.db;
  userId = (await ensureTestUser(db, "library-review-task@example.com")).id;
}, 60_000);

afterAll(async () => { await deps?.close(); });

beforeEach(async () => {
  await db.execute(sql`truncate tasks, cv_libraries, cv_library_reviews, ai_calls, ai_reservations, user_settings restart identity cascade`);
  deps.aiClient = undefined;
  deps.invalidateSettings();
});

it("writes the rules baseline before it asks a model anything, then replaces it with the review", async () => {
  await saveLibrary(1, libraryOf());
  const scripted = scriptedClient();
  deps.aiClient = scripted.client;

  const result = await handleReviewLibrary(task({ userId, libraryVersion: 1 }), deps);

  expect(result).toMatchObject({ reviewed: 2, reused: 0 });
  expect((result as { cost: number }).cost).toBeGreaterThan(0);
  // The call saw a full baseline already stored: a Library opened while the task runs has a score.
  expect(scripted.calls).toHaveLength(1);
  expect(scripted.calls[0]!.baseline.map(row => [row.entryId, row.source])).toEqual([["later", "rules"], ["role", "rules"]]);
  // Only experience is sent: an education or skill block is neither reviewed nor scored, and an
  // entry with no rows is not evidence of anything.
  expect(scripted.calls[0]!.entries).toEqual(["role", "later"]);
  expect(scripted.calls[0]!.rows).toEqual([ROWS.ran, ROWS.cut, ROWS.led]);

  const stored = await reviews();
  expect(stored.map(row => [row.entryId, row.source, row.model])).toEqual([
    ["later", "model", "claude-fable-5-1"],
    ["role", "model", "claude-fable-5-1"],
  ]);
  // One row per entry per version: the baseline was replaced in place, not accumulated beside.
  expect(stored).toHaveLength(2);
  expect(stored.every(row => row.libraryVersion === 1 && row.score > 0)).toBe(true);
  expect(stored.find(row => row.entryId === "role")!.review.rows.every(row => row.verified)).toBe(true);

  // Recorded against the account, under its own call site and stage.
  const calls = await db.select().from(schema.aiCalls);
  expect(calls.map(row => [row.callSite, row.stage, row.userId, row.refId])).toEqual([
    ["A12", "review", userId, `library:${userId}:1`],
  ]);
  // The hold is given back: the call's real cost is in `ai_calls` and nothing is left reserved.
  expect(await db.select().from(schema.aiReservations)).toHaveLength(0);
});

it("reuses an unchanged entry's review across a save and sends only the entry whose row changed", async () => {
  await saveLibrary(1, libraryOf());
  const first = scriptedClient();
  deps.aiClient = first.client;
  await handleReviewLibrary(task({ userId, libraryVersion: 1 }), deps);

  // A typo fixed in one row of one entry; the other job is untouched.
  const edited = libraryOf({ first: "Ran the UK warehouse team of 30 through a move to a new site in Leeds" });
  await saveLibrary(2, edited);
  const second = scriptedClient();
  deps.aiClient = second.client;

  const result = await handleReviewLibrary(task({ userId, libraryVersion: 2 }), deps);

  expect(result).toMatchObject({ reviewed: 1, reused: 1 });
  expect(second.calls).toHaveLength(1);
  expect(second.calls[0]!.entries).toEqual(["role"]);
  const stored = await reviews();
  // Version 2 carries both: the edited entry reviewed again, the untouched one on its old answer,
  // copied forward so it lives as long as the version does.
  const v2 = stored.filter(row => row.libraryVersion === 2);
  expect(v2.map(row => [row.entryId, row.source])).toEqual([["later", "model"], ["role", "model"]]);
  expect(v2.find(row => row.entryId === "role")!.inputHash)
    .toBe(libraryEntryInputHash(edited.entries[0]!, edited.employment![0]!));

  // Asked again with nothing changed at all, nothing is sent and nothing is billed a third time —
  // and the model review already stored against this version survives the baseline write.
  const third = scriptedClient();
  deps.aiClient = third.client;
  expect(await handleReviewLibrary(task({ userId, libraryVersion: 2 }), deps)).toMatchObject({ reviewed: 0, reused: 2 });
  expect(third.calls).toHaveLength(0);
  expect((await reviews()).filter(row => row.libraryVersion === 2).map(row => [row.entryId, row.source]))
    .toEqual([["later", "model"], ["role", "model"]]);
});

it("asks only about the row that changed within an edited entry, and keeps the others' marks", async () => {
  await saveLibrary(1, libraryOf());
  deps.aiClient = scriptedClient().client;
  await handleReviewLibrary(task({ userId, libraryVersion: 1 }), deps);
  const before = (await reviews()).find(row => row.entryId === "role")!;

  // The second row of the role is reworded; its first row, and the other job, are untouched.
  const reworded = "Cut handover time from two days to three hours";
  const library = libraryOf();
  await saveLibrary(2, { ...library, entries: library.entries.map(entry => entry.id === "role" ? { ...entry, details: [ROWS.ran, reworded].join("\n") } : entry) });
  let shown: string[] = [];
  const second = scriptedClient();
  deps.aiClient = { messages: { create: async params => {
    shown = batchOf(params).flatMap(entry => entry.all);
    return second.client.messages.create(params);
  } } };

  expect(await handleReviewLibrary(task({ userId, libraryVersion: 2 }), deps)).toMatchObject({ reviewed: 1, reused: 1 });
  // One call, about one entry, asking for one row — with the whole entry shown for its questions.
  expect(second.calls.map(call => [call.entries, call.rows])).toEqual([[["role"], [reworded]]]);
  expect(shown).toEqual([ROWS.ran, reworded]);

  const after = (await reviews()).find(row => row.entryId === "role" && row.libraryVersion === 2)!;
  expect(after.source).toBe("model");
  // The unchanged row keeps what the first review said about it; the reworded row is the new answer.
  expect(after.review.rows[0]).toEqual({ ...before.review.rows[0]!, tagged: [] });
  expect(after.review.rows[1]).toMatchObject({ row: reworded, verified: true, facets: ["responsibility"] });
  expect(after.review.unread).toBeUndefined();
});

it("re-reviews nothing when a row is only re-tagged, and carries the review with the new tags", async () => {
  await saveLibrary(1, libraryOf());
  deps.aiClient = scriptedClient().client;
  await handleReviewLibrary(task({ userId, libraryVersion: 1 }), deps);

  const library = libraryOf();
  const retagged = { ...library, entries: library.entries.map(entry => entry.id === "role" ? setRowFacets(entry, ROWS.cut, ["metric"]) : entry) };
  await saveLibrary(2, retagged);
  const second = scriptedClient();
  deps.aiClient = second.client;

  expect(await handleReviewLibrary(task({ userId, libraryVersion: 2 }), deps)).toMatchObject({ reviewed: 0, reused: 2 });
  expect(second.calls).toHaveLength(0);
  const role = (await reviews()).filter(row => row.entryId === "role");
  expect(role.map(row => [row.libraryVersion, row.source])).toEqual([[1, "model"], [2, "model"]]);
  const [before, after] = [role[0]!, role[1]!];
  // The marks and the model's reading are about the wording and are carried as they were; the
  // tags are the ones saved now, and the stored score is read off them.
  expect(after.review.rows.map(row => row.tagged)).toEqual([[], ["metric"]]);
  expect(after.review.rows.map(row => [row.facets, row.marks])).toEqual(before.review.rows.map(row => [row.facets, row.marks]));
  expect(after.score).toBe(after.review.score);
});

it("carries an unchanged entry's model review into every newer version, so pruning never loses it", async () => {
  await saveLibrary(1, libraryOf());
  deps.aiClient = scriptedClient().client;
  await handleReviewLibrary(task({ userId, libraryVersion: 1 }), deps);
  const original = (await reviews()).find(row => row.entryId === "later")!;

  // Twenty-five saves, each editing only the role: the other job is never touched again.
  let paid = 0;
  for (let version = 2; version <= 26; version++) {
    await saveLibrary(version, libraryOf({ first: `Ran the UK warehouse team of 30 through site move number ${version}` }));
    const scripted = scriptedClient();
    deps.aiClient = scripted.client;
    await handleReviewLibrary(task({ userId, libraryVersion: version }), deps);
    paid += scripted.calls.filter(call => call.entries.includes("later")).length;
  }
  // Never asked about again, and still held as the model's answer after versions 1–6 were pruned.
  expect(paid).toBe(0);
  const later = (await reviews()).filter(row => row.entryId === "later");
  expect(Math.min(...later.map(row => row.libraryVersion))).toBeGreaterThan(1);
  expect(later.every(row => row.source === "model" && row.score === original.score && row.model === original.model)).toBe(true);
});

it("reviews the newest library when a burst of saves ran the task once, and says which it read", async () => {
  await saveLibrary(1, libraryOf());
  await saveLibrary(2, libraryOf({ first: "Ran the UK warehouse team of 30 through two site moves in one year" }));
  const scripted = scriptedClient();
  deps.aiClient = scripted.client;

  // The task carries the version of the save that enqueued it; two more landed while it waited.
  const result = await handleReviewLibrary(task({ userId, libraryVersion: 1 }), deps);

  expect(result).toMatchObject({ reviewed: 2, reused: 0, requestedVersion: 1, reviewedVersion: 2 });
  expect(scripted.calls[0]!.rows).toContain("Ran the UK warehouse team of 30 through two site moves in one year");
  expect((await reviews()).every(row => row.libraryVersion === 2)).toBe(true);
});

it("finishes done with the budget sentence when the account cannot afford the pass", async () => {
  await saveLibrary(1, libraryOf());
  await db.insert(schema.userSettings).values({ userId, key: "aiBudgetUsd", value: 0.01 });
  deps.invalidateSettings();
  const scripted = scriptedClient();
  deps.aiClient = scripted.client;

  const result = await handleReviewLibrary(task({ userId, libraryVersion: 1 }), deps) as { skipped: string; message: string; reviewed: number };

  expect(result.skipped).toBe("budget");
  expect(result.reviewed).toBe(0);
  expect(result.message).toContain("Library evidence review needs about $");
  expect(result.message).toContain("your budget of $0.01 has $0.01 left this month");
  expect(result.message).toContain("Raise it on Settings");
  // Nothing was asked of the model, and nothing is left holding capacity.
  expect(scripted.calls).toHaveLength(0);
  expect(await db.select().from(schema.aiCalls)).toHaveLength(0);
  expect(await db.select().from(schema.aiReservations)).toHaveLength(0);
  // The page is not left blank: the rules baseline stands for every entry.
  const stored = await reviews();
  expect(stored.map(row => [row.entryId, row.source])).toEqual([["later", "rules"], ["role", "rules"]]);
  // Nothing here is tagged, so no row has a score of its own and the entries read 0, but each row
  // carries the marks its wording earns, ready for the moment the person types it.
  const { rulesLibraryReview } = await import("@ava/core");
  const library = libraryOf();
  expect(stored.map(row => row.score)).toEqual(["later", "role"].map(id => rulesLibraryReview(library.entries.find(entry => entry.id === id)!, library).score));
  expect(stored.every(row => row.review.rows.every(item => item.marks.length > 0))).toBe(true);
});

it("keeps the baseline and lets the queue retry when the pass itself fails", async () => {
  await saveLibrary(1, libraryOf());
  deps.aiClient = { messages: { create: () => Promise.reject(new Error("Request timed out.")) } };

  await expect(handleReviewLibrary(task({ userId, libraryVersion: 1 }), deps)).rejects.toThrow();

  const stored = await reviews();
  expect(stored.map(row => row.source)).toEqual(["rules", "rules"]);
  expect(await db.select().from(schema.aiReservations)).toHaveLength(0);
  // Both attempts were billed for what they consumed, under the pass's own stages.
  const stages = (await db.select().from(schema.aiCalls).orderBy(desc(schema.aiCalls.at))).map(row => row.stage);
  expect(new Set(stages)).toEqual(new Set(["review", "review_retry"]));
});

it("still scores a library for a deployment with no model configured", async () => {
  await saveLibrary(1, libraryOf());
  const key = deps.env.anthropicApiKey;
  deps.env.anthropicApiKey = undefined;
  try {
    expect(await handleReviewLibrary(task({ userId, libraryVersion: 1 }), deps))
      .toMatchObject({ skipped: "ai unavailable", reviewed: 0 });
  } finally {
    deps.env.anthropicApiKey = key;
  }
  expect((await reviews()).map(row => [row.entryId, row.source])).toEqual([["later", "rules"], ["role", "rules"]]);
});

it("does not classify the evidence of a job that was removed", async () => {
  // Archived with its job: it is on no screen and in no CV, so it is not worth a model call — and
  // a block an earlier release stored as a draft is evidence, which is, so it is still reviewed.
  const library = libraryOf();
  await saveLibrary(1, {
    ...library,
    entries: [
      { ...library.entries[0]!, status: "inactive" },
      { ...library.entries[1]!, status: "draft" } as never,
      ...library.entries.slice(2),
    ],
  });
  deps.aiClient = scriptedClient().client;
  const result = await handleReviewLibrary(task({ userId, libraryVersion: 1 }), deps) as { reviewed: number };
  expect((await reviews()).map(row => row.entryId)).toEqual(["later"]);
  expect(result.reviewed).toBe(1);
});

it("does nothing but say so for an account with no library", async () => {
  expect(await handleReviewLibrary(task({ userId, libraryVersion: 1 }), deps)).toEqual({ skipped: "no library saved" });
  expect(await reviews()).toHaveLength(0);
});

it("keeps an entry the model left out on its baseline, and asks about it again on the next pass", async () => {
  await saveLibrary(1, libraryOf());
  const first = scriptedClient({ omit: ["later"] });
  deps.aiClient = first.client;

  expect(await handleReviewLibrary(task({ userId, libraryVersion: 1 }), deps)).toMatchObject({ reviewed: 1, unread: 1 });
  // Asked once more in the same pass, for that entry alone, as the engine does, and still left out.
  expect(first.calls.map(call => call.entries)).toEqual([["role", "later"], ["later"]]);
  const stored = await reviews();
  expect(stored.map(row => [row.entryId, row.source])).toEqual([["later", "rules"], ["role", "model"]]);
  // Its own facet tags still score it; the silence is not a model's zero.
  expect(stored.find(row => row.entryId === "later")!.score).toBe(
    (await import("@ava/core")).rulesLibraryReview(libraryOf().entries[1]!, libraryOf()).score,
  );

  const second = scriptedClient();
  deps.aiClient = second.client;
  expect(await handleReviewLibrary(task({ userId, libraryVersion: 1 }), deps)).toMatchObject({ reviewed: 1, reused: 1 });
  expect(second.calls.map(call => call.entries)).toEqual([["later"]]);
  expect((await reviews()).map(row => [row.entryId, row.source])).toEqual([["later", "model"], ["role", "model"]]);
});

it("reviews only experience: an education and a skill block are neither sent nor scored", async () => {
  const library = libraryOf();
  await saveLibrary(1, { ...library, entries: library.entries.filter(entry => entry.id !== "later") });
  const scripted = scriptedClient();
  deps.aiClient = scripted.client;

  expect(await handleReviewLibrary(task({ userId, libraryVersion: 1 }), deps)).toMatchObject({ reviewed: 1, reused: 0 });
  expect(scripted.calls.map(call => call.entries)).toEqual([["role"]]);
  expect(scripted.calls[0]!.rows).not.toContain(ROWS.msc);
  expect((await reviews()).map(row => [row.entryId, row.source])).toEqual([["role", "model"]]);
});
