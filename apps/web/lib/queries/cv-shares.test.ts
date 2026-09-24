/**
 * The reads behind a share link, against the database.
 *
 * The questions here are the ones that decide whether a public route is safe: does a token find
 * exactly one revision, does it stop finding it the moment the link is ended, and does what comes
 * back carry anything from the row it was read from that the reader has no business seeing.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, createCvShare, addCvShareComment, revokeCvShare, schema, type Db } from "@ava/db";
import { createTestDb } from "@/test/db";
import { runMigrations } from "@ava/db/migrate";
import { eq, sql } from "drizzle-orm";
import { ensureTestUser } from "@/test/auth";
import { materialiseCv, type CvLibrary } from "@ava/core/cv";
import { CV_PROFILE_ID, cvSectionBlockId } from "@/lib/cv-content-links";
import { hashCvShareToken, newCvShareToken } from "@/lib/cv-share";
import type { User } from "@ava/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let user: User;
let other: User;
vi.mock("@/lib/db", () => ({ db: () => database }));
import {
  countOwnOpenCvShareComments,
  getOwnCvSharing,
  sharedCvByToken,
} from "./cv-shares";

const LIBRARY: CvLibrary = {
  name: "Example Candidate",
  contact: "London",
  profile: "Operations leader",
  entries: [
    { id: "job", kind: "experience", heading: "Director · Acme", details: "Led a team", confirmedResponsibilities: ["Led a team"] },
  ],
};
const CONTENT = materialiseCv(LIBRARY, {
  summary: "Operations leader",
  sections: [{ entryId: "job", bullets: ["Led a team"] }],
  gaps: [],
});
const SECRET_DESCRIPTION = "A confidential advert the reader must never be shown.";

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
}, 120_000);
afterAll(async () => {
  // The database is shared with every other suite, and one of them counts what the scheduler
  // queues — which is one task per account it finds. Leave no accounts behind.
  await database.execute(sql`truncate users restart identity cascade`);
  await pool?.end();
});
beforeEach(async () => {
  await database.execute(sql`truncate cv_libraries, cv_drafts, companies, decisions, tasks, settings, users restart identity cascade`);
  user = await ensureTestUser(database);
  other = await ensureTestUser(database, "other@example.com", "member");
});

async function draft(over: Partial<typeof schema.cvDrafts.$inferInsert> = {}) {
  const [row] = await database.insert(schema.cvDrafts).values({
    userId: user.id, jobTitle: "Operations Manager", companyName: "Acme",
    jobDescription: SECRET_DESCRIPTION, libraryVersion: 1, librarySnapshot: LIBRARY,
    model: "test", status: "ready", revision: 1, content: CONTENT, ...over,
  }).returning();
  return row!;
}

/** One link onto one revision, and the plain token that opens it. */
async function share(draftId: string, over: { allowComments?: boolean; expiresAt?: Date } = {}) {
  const token = newCvShareToken();
  const row = await createCvShare(database, {
    userId: user.id,
    draftId,
    tokenHash: hashCvShareToken(token),
    allowComments: over.allowComments,
    expiresAt: over.expiresAt ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
  });
  return { token, share: row };
}

it("finds one revision by its plain token, and nothing else from the row", async () => {
  const cv = await draft();
  const { token, share: link } = await share(cv.id);
  const found = await sharedCvByToken(token);
  expect(found).not.toBeNull();
  expect(found!.shareId).toBe(link.id);
  expect(found!.userId).toBe(user.id);
  expect(found!.draftId).toBe(cv.id);
  expect(found!.content.name).toBe("Example Candidate");
  expect(found!.content.sections[0]!.bullets).toEqual(["Led a team"]);
  // The advert, the evidence library and the assessment live on the same row and are not read.
  expect(JSON.stringify(found)).not.toContain(SECRET_DESCRIPTION);
  expect(Object.keys(found!).sort()).toEqual(
    ["allowComments", "comments", "content", "draftId", "expiresAt", "shareId", "userId"],
  );
});

it("finds nothing for a token that is unknown, malformed or not a token at all", async () => {
  const cv = await draft();
  await share(cv.id);
  expect(await sharedCvByToken(newCvShareToken())).toBeNull();
  expect(await sharedCvByToken("")).toBeNull();
  expect(await sharedCvByToken("../../etc/passwd")).toBeNull();
});

it("stops finding a revision the moment the link expires or is revoked", async () => {
  const cv = await draft();
  const expired = await share(cv.id, { expiresAt: new Date(Date.now() - 1000) });
  expect(await sharedCvByToken(expired.token)).toBeNull();

  const live = await share(cv.id);
  expect(await sharedCvByToken(live.token)).not.toBeNull();
  expect(await revokeCvShare(database, user.id, live.share.id)).toBe(true);
  expect(await sharedCvByToken(live.token)).toBeNull();
  // A second revocation is not a second event.
  expect(await revokeCvShare(database, user.id, live.share.id)).toBe(false);
});

it("finds nothing once the revision is archived or has no content to show", async () => {
  const archived = await draft({ archivedAt: new Date() });
  const archivedLink = await share(archived.id);
  expect(await sharedCvByToken(archivedLink.token)).toBeNull();

  const building = await draft({ content: null, status: "generating" });
  const buildingLink = await share(building.id);
  expect(await sharedCvByToken(buildingLink.token)).toBeNull();
});

it("shows a reader the notes left through their own link, and no one else's", async () => {
  const cv = await draft();
  const first = await share(cv.id);
  const second = await share(cv.id);
  await addCvShareComment(database, {
    shareId: first.share.id, userId: user.id, anchor: CV_PROFILE_ID,
    authorName: "Sam", body: "The profile buries the operations work.",
  });
  await addCvShareComment(database, {
    shareId: second.share.id, userId: user.id, anchor: cvSectionBlockId("job"),
    authorName: "Jo", body: "Say what the team delivered.",
  });
  const firstView = await sharedCvByToken(first.token);
  expect(firstView!.comments.map((comment) => comment.authorName)).toEqual(["Sam"]);
  const secondView = await sharedCvByToken(second.token);
  expect(secondView!.comments.map((comment) => comment.authorName)).toEqual(["Jo"]);
  // The owner sees both, from every link, newest first.
  const owner = await getOwnCvSharing(user.id, cv.id);
  expect(owner.shares).toHaveLength(2);
  expect(owner.comments.map((comment) => comment.authorName)).toEqual(["Jo", "Sam"]);
  expect(owner.openCount).toBe(2);
  expect(await countOwnOpenCvShareComments(user.id, cv.id)).toBe(2);
});

it("keeps one account's links and notes out of another's reads", async () => {
  const cv = await draft();
  const link = await share(cv.id);
  await addCvShareComment(database, {
    shareId: link.share.id, userId: user.id, anchor: CV_PROFILE_ID, authorName: "Sam", body: "A note.",
  });
  const theirs = await getOwnCvSharing(other.id, cv.id);
  expect(theirs.shares).toEqual([]);
  expect(theirs.comments).toEqual([]);
  expect(theirs.openCount).toBe(0);
  expect(await countOwnOpenCvShareComments(other.id, cv.id)).toBe(0);
});

it("keeps the notes when the link they came through is revoked", async () => {
  const cv = await draft();
  const link = await share(cv.id);
  await addCvShareComment(database, {
    shareId: link.share.id, userId: user.id, anchor: CV_PROFILE_ID, authorName: "Sam", body: "A note.",
  });
  await revokeCvShare(database, user.id, link.share.id);
  expect(await sharedCvByToken(link.token)).toBeNull();
  const owner = await getOwnCvSharing(user.id, cv.id);
  expect(owner.comments.map((comment) => comment.body)).toEqual(["A note."]);
  const [stored] = await database.select().from(schema.cvShares).where(eq(schema.cvShares.id, link.share.id));
  // Only the hash was ever stored, so the link cannot be reconstructed from the row.
  expect(stored!.tokenHash).toBe(hashCvShareToken(link.token));
  expect(stored!.tokenHash).not.toContain(link.token);
});
