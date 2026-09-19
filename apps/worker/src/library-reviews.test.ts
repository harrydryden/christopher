/**
 * Stored evidence reviews, at the database: a pass round-trips, an edited entry hides the review
 * of its old wording, the model's answer beats the rules baseline that preceded it, the poll
 * signature moves only when a review does, and pruning keeps the newest versions.
 *
 * It lives in the worker because the db package has no test runner of its own, as
 * `company-logos.test.ts` does for the logo helpers.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createDb, latestLibraryReviews, libraryReviewsSignature, pruneLibraryReviews, schema,
  upsertLibraryReviews, type Db, type LibraryReviewUpsert,
} from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { rulesLibraryReview, type CvLibrary, type Employment, type LibraryEntryReview } from "@christopher/core";
import { sql } from "drizzle-orm";
import pg from "pg";
import { ensureTestUser } from "./test-users";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test";
const now = new Date("2026-09-19T09:00:00Z");
const later = new Date("2026-09-19T10:00:00Z");

let db: Db;
let pool: pg.Pool;
let userId: string;
let otherId: string;

beforeAll(async () => {
  const created = createDb(DATABASE_URL, { max: 1 });
  await runMigrations(created.db);
  db = created.db;
  pool = created.pool;
  userId = (await ensureTestUser(db, "library-reviews@example.com")).id;
  otherId = (await ensureTestUser(db, "library-reviews-other@example.com")).id;
}, 60_000);

afterAll(async () => { await pool?.end(); });

beforeEach(async () => { await db.execute(sql`truncate cv_library_reviews`); });

const job: Employment = { id: "acme", company: "Acme", jobTitle: "Operations Director", startDate: "2023-01", endDate: "", current: true };

/** A real review, so what is stored is the shape the Library will read back. */
function review(entryId: string, details: string): LibraryEntryReview {
  const library: CvLibrary = {
    name: "Test Candidate", contact: "London", profile: "Operations", structuredExperience: true, employment: [job],
    entries: [{ id: entryId, kind: "experience", status: "active", heading: "Operations Director · Acme", details, employmentId: "acme", rowFacets: { [details]: "outcome" } }],
  };
  return rulesLibraryReview(library.entries[0]!, library);
}

const entry = (entryId: string, inputHash: string, over: Partial<LibraryReviewUpsert> = {}): LibraryReviewUpsert => ({
  entryId, inputHash, review: review(entryId, `Cut handover time across the Acme network by 40%`), source: "rules", ...over,
});

it("writes a pass and reads back the review of each entry as it is written now", async () => {
  await upsertLibraryReviews(db, userId, 4, [entry("acme-block", "hash-a"), entry("older-block", "hash-b")], now);

  const found = await latestLibraryReviews(db, userId, [{ entryId: "acme-block", inputHash: "hash-a" }, { entryId: "older-block", inputHash: "hash-b" }]);
  expect([...found.keys()].sort()).toEqual(["acme-block", "older-block"]);
  const stored = found.get("acme-block")!;
  expect(stored).toMatchObject({ userId, libraryVersion: 4, entryId: "acme-block", inputHash: "hash-a", source: "rules", model: null });
  // The score and rating are stored beside the review so a list can be ordered without reading jsonb.
  expect(stored.score).toBe(stored.review.score);
  expect(stored.rating).toBe(stored.review.rating);
  expect(stored.review.rows[0]).toMatchObject({ facet: "outcome", quantified: true, verified: true });
  expect(stored.review.prompts.length).toBeGreaterThan(0);

  // Another account's reviews are not this account's, however the entry ids collide.
  await upsertLibraryReviews(db, otherId, 1, [entry("acme-block", "hash-a")], now);
  expect((await latestLibraryReviews(db, userId, [{ entryId: "acme-block", inputHash: "hash-a" }])).get("acme-block")!.libraryVersion).toBe(4);

  // Nothing asked for is nothing read.
  expect((await latestLibraryReviews(db, userId, [])).size).toBe(0);
});

it("hides the review of an entry whose wording changed, and keeps an unchanged one across versions", async () => {
  await upsertLibraryReviews(db, userId, 4, [entry("acme-block", "hash-a"), entry("older-block", "hash-b")], now);

  // Version 5: the person fixed a typo in one entry. Its hash moved; the other entry's did not.
  const found = await latestLibraryReviews(db, userId, [{ entryId: "acme-block", inputHash: "hash-a2" }, { entryId: "older-block", inputHash: "hash-b" }]);
  expect(found.has("acme-block")).toBe(false);
  // The untouched entry carries its review forward from version 4 without being reviewed again.
  expect(found.get("older-block")).toMatchObject({ libraryVersion: 4, inputHash: "hash-b" });

  // An entry never reviewed is simply absent, not an error.
  expect((await latestLibraryReviews(db, userId, [{ entryId: "brand-new", inputHash: "hash-c" }])).size).toBe(0);
  // One entry may not borrow another's matching hash: the pair has to be the pair.
  expect((await latestLibraryReviews(db, userId, [{ entryId: "acme-block", inputHash: "hash-b" }])).size).toBe(0);
});

it("prefers the model's review over the rules baseline it replaced, and replaces in place", async () => {
  await upsertLibraryReviews(db, userId, 4, [entry("acme-block", "hash-a")], now);
  await upsertLibraryReviews(db, userId, 4, [entry("acme-block", "hash-a", { source: "model", model: "claude-fable-5-1" })], later);

  // One row per (account, version, entry): the baseline is replaced, not accumulated beside.
  const rows = await db.select().from(schema.cvLibraryReviews);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ source: "model", model: "claude-fable-5-1" });
  expect(rows[0]!.createdAt.toISOString()).toBe(later.toISOString());

  // A later save rewrites the baseline under a new version; the model's answer for the same
  // wording still wins, because the hash says both describe the same text.
  await upsertLibraryReviews(db, userId, 5, [entry("acme-block", "hash-a")], new Date(later.getTime() + 60_000));
  const found = await latestLibraryReviews(db, userId, [{ entryId: "acme-block", inputHash: "hash-a" }]);
  expect(found.get("acme-block")).toMatchObject({ source: "model", libraryVersion: 4, model: "claude-fable-5-1" });
});

it("moves the poll signature when a review lands or changes, and not otherwise", async () => {
  expect(await libraryReviewsSignature(db, userId, 4)).toBe("0:");

  await upsertLibraryReviews(db, userId, 4, [entry("acme-block", "hash-a")], now);
  const first = await libraryReviewsSignature(db, userId, 4);
  expect(first).not.toBe("0:");
  // Writing the same review again changes nothing the Library would re-render.
  await upsertLibraryReviews(db, userId, 4, [entry("acme-block", "hash-a")], later);
  expect(await libraryReviewsSignature(db, userId, 4)).toBe(first);

  // The model's answer for the same entry does.
  await upsertLibraryReviews(db, userId, 4, [entry("acme-block", "hash-a", { source: "model", model: "claude-fable-5-1" })], later);
  const second = await libraryReviewsSignature(db, userId, 4);
  expect(second).not.toBe(first);

  // So does a second entry, a new score, and a new version being asked about.
  await upsertLibraryReviews(db, userId, 4, [entry("older-block", "hash-b")], later);
  expect(await libraryReviewsSignature(db, userId, 4)).not.toBe(second);
  await db.update(schema.cvLibraryReviews).set({ score: 11, rating: "none" });
  const rescored = await libraryReviewsSignature(db, userId, 4);
  expect(rescored).not.toBe(second);
  expect(await libraryReviewsSignature(db, userId, 5)).toBe("0:");
});

it("keeps the newest twenty library versions and drops what is older", async () => {
  for (let version = 1; version <= 25; version++) {
    await upsertLibraryReviews(db, userId, version, [entry("acme-block", `hash-${version}`)], now);
  }
  await upsertLibraryReviews(db, otherId, 1, [entry("acme-block", "hash-other")], now);

  expect(await pruneLibraryReviews(db, userId)).toBe(5);
  const kept = await db.selectDistinct({ version: schema.cvLibraryReviews.libraryVersion })
    .from(schema.cvLibraryReviews).where(sql`user_id = ${userId}`).orderBy(schema.cvLibraryReviews.libraryVersion);
  expect(kept.map(row => row.version)).toEqual(Array.from({ length: 20 }, (_, index) => index + 6));
  // Idempotent, and another account's reviews are never swept with this one's.
  expect(await pruneLibraryReviews(db, userId)).toBe(0);
  expect((await db.select().from(schema.cvLibraryReviews).where(sql`user_id = ${otherId}`))).toHaveLength(1);

  // An account with fewer than the retained number of versions loses nothing.
  expect(await pruneLibraryReviews(db, otherId)).toBe(0);
  expect(await pruneLibraryReviews(db, userId, 3)).toBe(17);
});
