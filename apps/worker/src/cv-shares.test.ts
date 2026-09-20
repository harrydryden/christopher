/**
 * Share links for a CV preview, at the database: a token finds one share and nothing else, a link
 * that has been ended is neither readable nor writable, views are counted for the owner, and every
 * note left on a link belongs to the account that opened it.
 *
 * It lives in the worker because the db package has no test runner of its own, as
 * `library-reviews.test.ts` does for the evidence reviews.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  addCvShareComment, countOpenCvShareComments, createCvShare, createDb, CvShareClosedError,
  findLiveCvShareByHash, listCvShareComments, listCvShares, recordCvShareView,
  resolveCvShareComment, revokeCvShare, schema,
  CV_SHARE_ANCHOR_MAX_CHARS, CV_SHARE_AUTHOR_NAME_MAX_CHARS, CV_SHARE_BODY_MAX_CHARS, type Db,
} from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import type { CvLibrary } from "@christopher/core";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { ensureTestUser } from "./test-users";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test";
/** Minutes from one fixed morning, so every expiry and ordering in here is the one the test wrote. */
const at = (minutes: number) => new Date(Date.parse("2026-09-19T09:00:00Z") + minutes * 60_000);
const MISSING_ID = "00000000-0000-4000-8000-000000000000";
const library: CvLibrary = { name: "Test Candidate", contact: "London", profile: "Operations", employment: [], entries: [] };

let db: Db;
let pool: pg.Pool;
let userId: string;
let otherId: string;
let draftId: string;
let otherDraftId: string;

/** A CV to share. Its content is beside the point here; the share only ever names it. */
async function makeDraft(owner: string): Promise<string> {
  const [draft] = await db.insert(schema.cvDrafts).values({
    userId: owner, jobTitle: "Operations Director", companyName: "Acme", jobDescription: "Lead a team",
    libraryVersion: 1, librarySnapshot: library, model: "test-engine",
  }).returning({ id: schema.cvDrafts.id });
  return draft!.id;
}

/** What a refusal was, as one word, so a test reads as the sentence the page will show. */
async function refusalOf(attempt: Promise<unknown>): Promise<string> {
  try {
    await attempt;
    return "accepted";
  } catch (error) {
    return error instanceof CvShareClosedError ? error.reason : `other: ${(error as Error).message}`;
  }
}

/** The constraint a write ran into. The driver names it; drizzle wraps the driver's error in its own. */
async function constraintOf(attempt: () => Promise<unknown>): Promise<string> {
  try {
    await attempt();
    return "accepted";
  } catch (error) {
    const cause = (error as { cause?: { constraint?: string } }).cause;
    return cause?.constraint ?? (error as Error).message;
  }
}

beforeAll(async () => {
  const created = createDb(DATABASE_URL, { max: 1 });
  await runMigrations(created.db);
  db = created.db;
  pool = created.pool;
  userId = (await ensureTestUser(db, "cv-shares@example.com")).id;
  otherId = (await ensureTestUser(db, "cv-shares-other@example.com")).id;
  draftId = await makeDraft(userId);
  otherDraftId = await makeDraft(otherId);
}, 60_000);

afterAll(async () => { await pool?.end(); });

beforeEach(async () => { await db.execute(sql`truncate cv_shares cascade`); });

it("opens a link onto one preview, finds it by its hash, and counts what the reader read", async () => {
  const share = await createCvShare(db, { userId, draftId, tokenHash: "hash-one", expiresAt: at(60) }, at(0));
  expect(share).toMatchObject({ userId, draftId, allowComments: true, viewCount: 0, revokedAt: null, lastViewedAt: null });

  // The lookup yields the owner to scope the read by, the draft to render, and nothing else.
  const live = await findLiveCvShareByHash(db, "hash-one", at(1));
  expect(live).toEqual({ id: share.id, userId, draftId, allowComments: true, expiresAt: share.expiresAt });
  expect(live).not.toHaveProperty("tokenHash");
  // An unknown link is simply nothing.
  expect(await findLiveCvShareByHash(db, "hash-nobody-issued", at(1))).toBeNull();

  await recordCvShareView(db, share.id, at(2));
  await recordCvShareView(db, share.id, at(3));
  const [counted] = await listCvShares(db, userId, draftId);
  expect(counted).toMatchObject({ id: share.id, viewCount: 2 });
  expect(counted!.lastViewedAt!.toISOString()).toBe(at(3).toISOString());

  // Every link onto this CV, newest first; another account's list of the same draft is empty.
  const second = await createCvShare(db, { userId, draftId, tokenHash: "hash-two", allowComments: false, expiresAt: at(60) }, at(4));
  expect((await listCvShares(db, userId, draftId)).map(row => row.id)).toEqual([second.id, share.id]);
  expect(await listCvShares(db, otherId, draftId)).toEqual([]);
  expect(await listCvShares(db, userId, otherDraftId)).toEqual([]);
});

it("ends with the CV it shows: deleting the draft takes its links and their notes", async () => {
  const throwaway = await makeDraft(userId);
  const share = await createCvShare(db, { userId, draftId: throwaway, tokenHash: "hash-throwaway", expiresAt: at(60) }, at(0));
  await addCvShareComment(db, { shareId: share.id, userId, anchor: "cv-profile", authorName: "Sam", body: "One line on the profile." }, at(1));

  await db.delete(schema.cvDrafts).where(eq(schema.cvDrafts.id, throwaway));
  expect(await findLiveCvShareByHash(db, "hash-throwaway", at(2))).toBeNull();
  expect(await listCvShareComments(db, userId, throwaway)).toEqual([]);
  expect(await db.select().from(schema.cvShareComments)).toEqual([]);
});

it("a revoked, expired or read-only link is not written to, and says which it was", async () => {
  const note = (shareId: string) => ({ shareId, userId, anchor: "cv-profile", authorName: "Sam", body: "The profile buries the best line." });

  const revoked = await createCvShare(db, { userId, draftId, tokenHash: "hash-revoked", expiresAt: at(60) }, at(0));
  expect(await revokeCvShare(db, otherId, revoked.id, at(1))).toBe(false);
  expect(await revokeCvShare(db, userId, revoked.id, at(1))).toBe(true);
  expect(await revokeCvShare(db, userId, revoked.id, at(2))).toBe(false);
  expect(await findLiveCvShareByHash(db, "hash-revoked", at(2))).toBeNull();
  expect(await refusalOf(addCvShareComment(db, note(revoked.id), at(2)))).toBe("revoked");

  // Expiry is the same answer without anyone doing anything.
  const expiring = await createCvShare(db, { userId, draftId, tokenHash: "hash-expiring", expiresAt: at(10) }, at(0));
  expect(await findLiveCvShareByHash(db, "hash-expiring", at(9))).toMatchObject({ id: expiring.id });
  expect(await findLiveCvShareByHash(db, "hash-expiring", at(11))).toBeNull();
  expect(await refusalOf(addCvShareComment(db, note(expiring.id), at(11)))).toBe("expired");

  // A read-only link is live — the reader sees the CV, they just cannot write on it.
  const readOnly = await createCvShare(db, { userId, draftId, tokenHash: "hash-read-only", allowComments: false, expiresAt: at(60) }, at(0));
  expect(await findLiveCvShareByHash(db, "hash-read-only", at(1))).toMatchObject({ allowComments: false });
  expect(await refusalOf(addCvShareComment(db, note(readOnly.id), at(1)))).toBe("comments_off");

  // A link that never existed reads as one that has ended: the reader is told no more than that.
  expect(await refusalOf(addCvShareComment(db, note(MISSING_ID), at(1)))).toBe("missing");
});

it("stores a note against the owner of the share, and shows it to nobody else", async () => {
  const share = await createCvShare(db, { userId, draftId, tokenHash: "hash-open", expiresAt: at(60) }, at(0));
  const second = await createCvShare(db, { userId, draftId, tokenHash: "hash-open-two", expiresAt: at(60) }, at(1));

  const first = await addCvShareComment(db, { shareId: share.id, userId, anchor: "cv-profile", authorName: " Sam ", body: "  The profile buries the best line.  " }, at(2));
  expect(first).toMatchObject({ userId, shareId: share.id, anchor: "cv-profile", authorName: "Sam", body: "The profile buries the best line.", resolvedAt: null });
  const later = await addCvShareComment(db, { shareId: second.id, userId, anchor: "section-acme", authorName: "Jo", body: "Put the number in this one." }, at(3));

  // Flat and newest first, from every link onto the CV.
  expect((await listCvShareComments(db, userId, draftId)).map(row => row.id)).toEqual([later.id, first.id]);
  expect(await countOpenCvShareComments(db, userId, draftId)).toBe(2);
  // Another account sees none of it, however it asks.
  expect(await listCvShareComments(db, otherId, draftId)).toEqual([]);
  expect(await countOpenCvShareComments(db, otherId, draftId)).toBe(0);
  expect(await listCvShareComments(db, userId, otherDraftId)).toEqual([]);
  // The owner stored is the share's, never the caller's claim about it.
  expect(await refusalOf(addCvShareComment(db, { shareId: share.id, userId: otherId, anchor: "cv-profile", authorName: "Sam", body: "Not theirs to write as." }, at(4))))
    .toMatch(/another account/);

  // Resolving is the owner's, and only the call that closed it says so.
  expect(await resolveCvShareComment(db, otherId, first.id, at(5))).toBe(false);
  expect(await resolveCvShareComment(db, userId, first.id, at(5))).toBe(true);
  expect(await resolveCvShareComment(db, userId, first.id, at(6))).toBe(false);
  expect(await countOpenCvShareComments(db, userId, draftId)).toBe(1);
  // A resolved note is still readable: it is marked dealt with, not deleted.
  expect((await listCvShareComments(db, userId, draftId)).find(row => row.id === first.id)!.resolvedAt!.toISOString()).toBe(at(5).toISOString());

  // Revoking a link keeps what was said on it, and the cap is the page's.
  await revokeCvShare(db, userId, share.id, at(7));
  expect((await listCvShareComments(db, userId, draftId)).map(row => row.id)).toEqual([later.id, first.id]);
  expect((await listCvShareComments(db, userId, draftId, 1)).map(row => row.id)).toEqual([later.id]);
});

it("refuses a note that is empty or too long, before the column has to", async () => {
  const share = await createCvShare(db, { userId, draftId, tokenHash: "hash-lengths", expiresAt: at(60) }, at(0));
  const base = { shareId: share.id, userId, anchor: "cv-profile", authorName: "Sam" };

  await expect(async () => { await addCvShareComment(db, { ...base, body: "   " }, at(1)); }).rejects.toThrow(/a note is required/);
  await expect(async () => { await addCvShareComment(db, { ...base, body: "x".repeat(CV_SHARE_BODY_MAX_CHARS + 1) }, at(1)); }).rejects.toThrow(/at most 2000 characters/);
  await expect(async () => { await addCvShareComment(db, { ...base, authorName: "n".repeat(CV_SHARE_AUTHOR_NAME_MAX_CHARS + 1), body: "Fine." }, at(1)); }).rejects.toThrow(/at most 80 characters/);
  await expect(async () => { await addCvShareComment(db, { ...base, anchor: "a".repeat(CV_SHARE_ANCHOR_MAX_CHARS + 1), body: "Fine." }, at(1)); }).rejects.toThrow(/anchor is missing or too long/);

  // The longest note anyone is allowed is stored whole.
  expect((await addCvShareComment(db, { ...base, body: "x".repeat(CV_SHARE_BODY_MAX_CHARS) }, at(2))).body).toHaveLength(CV_SHARE_BODY_MAX_CHARS);
  // And the columns say the same to anything that writes around the helper.
  expect(await constraintOf(() => db.insert(schema.cvShareComments).values({ shareId: share.id, userId, anchor: "cv-profile", authorName: "Sam", body: "" })))
    .toBe("cv_share_comments_body_length_check");
});
