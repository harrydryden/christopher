/**
 * Sharing one CV preview, end to end: the owner opens a link, a reader without a session opens it
 * and leaves a note, and the note comes back to the owner as a row in the evaluation table.
 *
 * The things worth proving here are the ones a unit test cannot: that the plain token never
 * reaches the database, that the public page reads one revision and nothing else from the account
 * that owns it, that ending a link ends it for everyone at once, and that both the page and the
 * comments route stop answering once the throttle has been reached.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, resolveCvShareComment as resolveCommentRow, schema, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { desc, eq, isNull, sql } from "drizzle-orm";
import { signInTestUser, ensureTestUser } from "@/test/auth";
import { materialiseCv, type CvLibrary } from "@ava/core/cv";
import { createCvAssessment } from "@ava/core/cv-review";
import { cvTextItems, cvClaimItems, cvEvidenceItems } from "@ava/core/cv-assessment";
import { rubricFixture, reviewFixture } from "../../../../packages/core/test/cv-review-fixture";
import type { User } from "@ava/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;
let user: User;
let other: User;
let requestHeaders = new Headers();
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session ? { value: session } : undefined) }),
  headers: async () => requestHeaders,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createCvShareLink, resolveCvShareComment, revokeCvShareLink } from "./cv-share";
import { POST as postComment } from "@/app/share/[token]/comments/route";
import SharedCvPage from "@/app/share/[token]/page";
import { sharedCvByToken, getOwnCvSharing } from "@/lib/queries/cv-shares";
import { cvEvaluationRows } from "@/lib/cv-evaluation";
import { CV_PROFILE_ID, cvSectionBlockId } from "@/lib/cv-content-links";
import {
  CV_SHARE_COMMENT_REQUEST_MAX_BYTES,
  CV_SHARE_GONE_SENTENCE,
  CV_SHARE_BUSY_SENTENCE,
  CV_SHARE_THANKS_SENTENCE,
  cvShareCommentKeys,
  cvShareViewKeys,
  hashCvShareToken,
} from "@/lib/cv-share";
import { LIMITS } from "@/lib/rate-limit";
import { NextRequest } from "next/server";
import { config as middlewareConfig, middleware } from "@/middleware";

const LIBRARY: CvLibrary = {
  name: "Example Candidate",
  contact: "London",
  profile: "Operations leader",
  entries: [
    { id: "job", kind: "experience", heading: "Director · Acme", details: "Led a team", confirmedResponsibilities: ["Led a team"] },
  ],
};
const CONTENT = materialiseCv(LIBRARY, {
  summary: "Operations leader who runs the plan",
  sections: [{ entryId: "job", bullets: ["Led a team"] }],
  gaps: [],
});
const DESCRIPTION = "Lead a team and improve operations. This advert must never reach a reader.";
const SECTION_ANCHOR = cvSectionBlockId("job");

beforeAll(async () => {
  const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test");
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = "integration-test-secret";
}, 120_000);
afterAll(async () => {
  // The database is shared with every other suite, and one of them counts what the scheduler
  // queues — which is one task per account it finds. Leave no accounts behind.
  await database.execute(sql`truncate users restart identity cascade`);
  await pool?.end();
});
beforeEach(async () => {
  await database.execute(sql`truncate cv_libraries, cv_drafts, companies, decisions, tasks, settings, login_attempts, users restart identity cascade`);
  ({ user, cookie: session } = await signInTestUser(database, process.env.SESSION_SECRET!));
  other = await ensureTestUser(database, "other@example.com", "member");
  requestHeaders = new Headers({ host: "ava.test", "x-forwarded-for": "203.0.113.5" });
});

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

/** The assessment a finished build leaves on its draft, made a minute before the test runs. */
function assessed(now = new Date(Date.now() - 60_000)) {
  const rubric = rubricFixture(DESCRIPTION);
  const review = reviewFixture({
    rubric, cv: cvTextItems(CONTENT), claims: cvClaimItems(CONTENT), evidence: cvEvidenceItems(LIBRARY),
  });
  return createCvAssessment({
    content: CONTENT, description: DESCRIPTION, library: LIBRARY, rubric, review, model: "test", pageCount: 2, now,
  });
}

async function draft(over: Partial<typeof schema.cvDrafts.$inferInsert> = {}) {
  const [row] = await database.insert(schema.cvDrafts).values({
    userId: user.id, jobTitle: "Operations Manager", companyName: "Acme",
    jobDescription: DESCRIPTION, libraryVersion: 1, librarySnapshot: LIBRARY,
    model: "test", status: "ready", revision: 1, content: CONTENT, assessment: assessed(), ...over,
  }).returning();
  return row!;
}

/** Open a link the way the workspace does, and hand back the plain token from the result. */
async function open(draftId: string, fields: Record<string, string> = { days: "14", allowComments: "on" }) {
  const result = await createCvShareLink(draftId, { ok: true }, form(fields));
  expect(result.ok).toBe(true);
  const link = result.ok ? result.link! : "";
  return { result, link, token: link.split("/share/")[1]! };
}

/** Every string anywhere in a rendered tree, so a page can be asked what it says and what it does not. */
function words(node: unknown, out: string[] = [], seen = new Set<object>()): string {
  if (node === null || node === undefined || typeof node === "boolean") return out.join(" ");
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out.join(" "); }
  if (typeof node !== "object") return out.join(" ");
  if (seen.has(node)) return out.join(" ");
  seen.add(node);
  for (const value of Object.values(node)) words(value, out, seen);
  return out.join(" ");
}

const render = async (token: string, query: Record<string, string> = {}) =>
  words(await SharedCvPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve(query) }));

const comment = (token: string, fields: Record<string, string>, address = "198.51.100.9") =>
  postComment(
    new Request(`https://ava.test/share/${token}/comments`, {
      method: "POST",
      body: form(fields),
      headers: { "x-forwarded-for": address },
    }),
    { params: Promise.resolve({ token }) },
  );

it("hands the owner a link once, stores only its hash, and opens one revision with it", async () => {
  const cv = await draft();
  const { result, link, token } = await open(cv.id);
  expect(link).toMatch(/^https:\/\/ava\.test\/share\/[A-Za-z0-9_-]{43}$/);
  expect(result.ok && result.message).toContain("14 days");

  const [stored] = await database.select().from(schema.cvShares);
  expect(stored!.tokenHash).toBe(hashCvShareToken(token));
  expect(stored!.allowComments).toBe(true);
  // Nothing in the row can reproduce the link.
  expect(JSON.stringify(stored)).not.toContain(token);
  // Fourteen days, to the day.
  const days = Math.round((stored!.expiresAt.getTime() - stored!.createdAt.getTime()) / 86_400_000);
  expect(days).toBe(14);

  const found = await sharedCvByToken(token);
  expect(found!.draftId).toBe(cv.id);
  expect(found!.content.summary).toBe(CONTENT.summary);
});

it("refuses to open a link onto a CV this account does not own, or one with nothing to show", async () => {
  const [theirs] = await database.insert(schema.cvDrafts).values({
    userId: other.id, jobTitle: "Operations Manager", companyName: "Acme", jobDescription: DESCRIPTION,
    libraryVersion: 1, librarySnapshot: LIBRARY, model: "test", status: "ready", revision: 1, content: CONTENT,
  }).returning();
  expect(await createCvShareLink(theirs!.id, { ok: true }, form({}))).toEqual({
    ok: false, error: "That CV could not be found.",
  });
  expect(await createCvShareLink("not-a-uuid", { ok: true }, form({}))).toEqual({
    ok: false, error: "That CV could not be found.",
  });
  const building = await draft({ content: null, status: "generating" });
  expect(await createCvShareLink(building.id, { ok: true }, form({}))).toEqual({
    ok: false, error: "This CV has nothing to show yet. Build it before sharing it.",
  });
  expect(await database.select().from(schema.cvShares)).toEqual([]);
});

it("opens a link only onto a revision whose build and assessment have finished", async () => {
  const refusal = { ok: false, error: "Share this CV once its build and assessment have finished." };
  // Wording from a build that failed, or never had its facts checked, is not one to send anyone.
  const failed = await draft({ status: "failed" });
  expect(await createCvShareLink(failed.id, { ok: true }, form({}))).toEqual(refusal);
  const unassessed = await draft({ assessment: null });
  expect(await createCvShareLink(unassessed.id, { ok: true }, form({}))).toEqual(refusal);
  const rebuilding = await draft({ status: "queued" });
  expect(await createCvShareLink(rebuilding.id, { ok: true }, form({}))).toEqual(refusal);
  expect(await database.select().from(schema.cvShares)).toEqual([]);
});

it("shows only the revision a link was opened on, never one written over it since", async () => {
  const cv = await draft();
  const { token } = await open(cv.id);
  expect((await sharedCvByToken(token))!.content.summary).toBe(CONTENT.summary);

  // The draft is sent back to the worker: while it is rewritten the link reads as closed.
  for (const status of ["queued", "generating", "failed"] as const) {
    await database.update(schema.cvDrafts).set({ status }).where(eq(schema.cvDrafts.id, cv.id));
    expect(await sharedCvByToken(token)).toBeNull();
  }
  // It publishes again, with wording the reader was never sent: the link stays closed.
  await database.update(schema.cvDrafts)
    .set({ status: "ready", content: { ...CONTENT, summary: "Different wording" }, assessment: assessed(new Date(Date.now() + 60_000)) })
    .where(eq(schema.cvDrafts.id, cv.id));
  expect(await sharedCvByToken(token)).toBeNull();
  expect(await render(token)).toContain(CV_SHARE_GONE_SENTENCE);
  // A new link onto the new revision shows it.
  await database.update(schema.cvDrafts).set({ assessment: assessed() }).where(eq(schema.cvDrafts.id, cv.id));
  const again = await open(cv.id);
  expect((await sharedCvByToken(again.token))!.content.summary).toBe("Different wording");
});

it("keeps the expiry inside ninety days however many are asked for", async () => {
  const cv = await draft();
  await open(cv.id, { days: "9999" });
  const [stored] = await database.select().from(schema.cvShares);
  expect(Math.round((stored!.expiresAt.getTime() - stored!.createdAt.getTime()) / 86_400_000)).toBe(90);
});

it("shows the revision to a reader with no session, counts the reading, and shows nothing else", async () => {
  const cv = await draft();
  const { token } = await open(cv.id);
  const page = await render(token);
  expect(page).toContain("Example Candidate");
  expect(page).toContain("Operations leader who runs the plan");
  expect(page).toContain("Led a team");
  expect(page).toContain("Shared CV · read only");
  // The advert on the same row is never selected, so it cannot be rendered.
  expect(page).not.toContain("This advert must never reach a reader");

  await render(token);
  const [stored] = await database.select().from(schema.cvShares);
  expect(stored!.viewCount).toBe(2);
  expect(stored!.lastViewedAt).not.toBeNull();
});

it("says the same sentence for a link that never existed, one that expired and one that was revoked", async () => {
  const cv = await draft();
  const { token } = await open(cv.id);
  const [stored] = await database.select().from(schema.cvShares);
  await revokeCvShareLink(stored!.id, cv.id);
  expect(await render(token)).toContain(CV_SHARE_GONE_SENTENCE);

  const expiring = await open(cv.id, { days: "1" });
  await database.update(schema.cvShares)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(schema.cvShares.tokenHash, hashCvShareToken(expiring.token)));
  expect(await render(expiring.token)).toContain(CV_SHARE_GONE_SENTENCE);

  expect(await render("this-is-not-a-token")).toContain(CV_SHARE_GONE_SENTENCE);
});

it("takes a note from a reader, files it against the block, and shows it to the owner alone", async () => {
  const cv = await draft();
  const { token } = await open(cv.id);
  const response = await comment(token, {
    anchor: CV_PROFILE_ID, authorName: "Sam Reader", body: "The profile buries the operations work.",
  });
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toContain("thanks=1");
  expect(response.headers.get("location")).toContain(`#${CV_PROFILE_ID}`);

  const owner = await getOwnCvSharing(user.id, cv.id);
  expect(owner.comments).toHaveLength(1);
  expect(owner.comments[0]!.authorName).toBe("Sam Reader");
  expect(owner.comments[0]!.userId).toBe(user.id);
  expect((await getOwnCvSharing(other.id, cv.id)).comments).toEqual([]);

  // The next reader of the same link sees the first one's note, and the thanks line.
  const page = await render(token, { thanks: "1" });
  expect(page).toContain(CV_SHARE_THANKS_SENTENCE);
  expect(page).toContain("The profile buries the operations work.");
  expect(page).toContain("Sam Reader");
});

it("refuses a note on a read-only link, on a block this CV does not have, and on an ended link", async () => {
  const cv = await draft();
  const readOnly = await open(cv.id, { days: "14" });
  const refused = await comment(readOnly.token, { anchor: CV_PROFILE_ID, authorName: "Sam", body: "A note." });
  expect(refused.status).toBe(303);
  expect(refused.headers.get("location")).toContain("error=comments_off");

  const open2 = await open(cv.id, { allowComments: "on" });
  const wrongAnchor = await comment(open2.token, {
    anchor: cvSectionBlockId("someone-elses-job"), authorName: "Sam", body: "A note.",
  });
  expect(wrongAnchor.headers.get("location")).toContain("error=anchor");
  const blank = await comment(open2.token, { anchor: CV_PROFILE_ID, authorName: "   ", body: "A note." });
  expect(blank.headers.get("location")).toContain("error=invalid");

  const [live] = await database.select().from(schema.cvShares)
    .where(eq(schema.cvShares.tokenHash, hashCvShareToken(open2.token)));
  await revokeCvShareLink(live!.id, cv.id);
  const ended = await comment(open2.token, { anchor: CV_PROFILE_ID, authorName: "Sam", body: "A note." });
  expect(ended.status).toBe(404);
  expect(await ended.text()).toBe(CV_SHARE_GONE_SENTENCE);

  expect(await database.select().from(schema.cvShareComments)).toEqual([]);
});

it("refuses an oversized public comment before parsing its multipart body", async () => {
  const response = await postComment(
    new Request("https://ava.test/share/AAAAAAAAAAAAAAAAAAAAAA/comments", {
      method: "POST",
      body: "not parsed",
      headers: { "content-length": String(CV_SHARE_COMMENT_REQUEST_MAX_BYTES + 1) },
    }),
    { params: Promise.resolve({ token: "AAAAAAAAAAAAAAAAAAAAAA" }) },
  );
  expect(response.status).toBe(413);
  expect(await response.text()).toMatch(/too large/i);

  const headerless = await postComment(
    new Request("https://ava.test/share/AAAAAAAAAAAAAAAAAAAAAA/comments", {
      method: "POST",
      body: "x".repeat(CV_SHARE_COMMENT_REQUEST_MAX_BYTES + 1),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }),
    { params: Promise.resolve({ token: "AAAAAAAAAAAAAAAAAAAAAA" }) },
  );
  expect(headerless.status).toBe(413);

  const malformed = await postComment(
    new Request("https://ava.test/share/AAAAAAAAAAAAAAAAAAAAAA/comments", {
      method: "POST",
      body: "not multipart",
      headers: { "content-type": "multipart/form-data; boundary=missing" },
    }),
    { params: Promise.resolve({ token: "AAAAAAAAAAAAAAAAAAAAAA" }) },
  );
  expect(malformed.status).toBe(400);
});

it("stops answering once the throttle is reached, for reading and for writing", async () => {
  const cv = await draft();
  const { token } = await open(cv.id);
  const [viewKey] = cvShareViewKeys(hashCvShareToken(token), "203.0.113.5");
  for (let n = 0; n < LIMITS.shareView.max; n++) await database.insert(schema.loginAttempts).values({ key: viewKey! });
  const page = await render(token);
  expect(page).toContain(CV_SHARE_BUSY_SENTENCE);
  expect(page).not.toContain("Example Candidate");
  // A throttled reading is not a reading.
  const [stored] = await database.select().from(schema.cvShares);
  expect(stored!.viewCount).toBe(0);

  const [commentKey] = cvShareCommentKeys(hashCvShareToken(token), "198.51.100.9");
  for (let n = 0; n < LIMITS.shareComment.max; n++) await database.insert(schema.loginAttempts).values({ key: commentKey! });
  const refused = await comment(token, { anchor: CV_PROFILE_ID, authorName: "Sam", body: "A note." });
  expect(refused.status).toBe(429);
  expect(await database.select().from(schema.cvShareComments)).toEqual([]);
});

it("brings a reader's note back as a Comment row, and takes it away when it is resolved", async () => {
  const cv = await draft();
  const { token } = await open(cv.id);
  await comment(token, { anchor: CV_PROFILE_ID, authorName: "Sam", body: "Say what the plan delivered." });
  await comment(token, { anchor: SECTION_ANCHOR, authorName: "Jo", body: "Name the team size." });

  const rubric = rubricFixture(DESCRIPTION);
  const review = reviewFixture({
    rubric, cv: cvTextItems(CONTENT), claims: cvClaimItems(CONTENT), evidence: cvEvidenceItems(LIBRARY),
  });
  const assessment = createCvAssessment({
    content: CONTENT, description: DESCRIPTION, library: LIBRARY, rubric, review, model: "test", pageCount: 2,
  });

  const withNotes = await getOwnCvSharing(user.id, cv.id);
  const rows = cvEvaluationRows(assessment, CONTENT, LIBRARY, withNotes.comments);
  const commentRows = rows.filter((row) => row.change === "Comment");
  expect(commentRows).toHaveLength(2);
  // Newest block first: Jo's note arrived last.
  expect(commentRows[0]!.id).toBe(`comment:${SECTION_ANCHOR}`);
  expect(commentRows[0]!.suggestion).toContain("Jo: Name the team size.");
  expect(commentRows[0]!.contentLinks).toEqual([{ id: SECTION_ANCHOR, label: "Director · Acme" }]);
  // A note is not a gap: it never sends the person to the Library.
  expect(commentRows.every((row) => row.libraryHref === undefined)).toBe(true);

  const [newest] = await database.select().from(schema.cvShareComments)
    .orderBy(desc(schema.cvShareComments.createdAt)).limit(1);
  await resolveCvShareComment(newest!.id, cv.id);
  const resolved = await getOwnCvSharing(user.id, cv.id);
  expect(cvEvaluationRows(assessment, CONTENT, LIBRARY, resolved.comments).filter((row) => row.change === "Comment"))
    .toHaveLength(1);
  expect(resolved.comments.find((note) => note.id === newest!.id)!.resolvedAt).not.toBeNull();

  // Resolving is the owner's and nobody else's: the same note, asked for by another account, moves
  // nothing and says so.
  const [stillOpen] = await database.select().from(schema.cvShareComments)
    .where(isNull(schema.cvShareComments.resolvedAt)).limit(1);
  expect(stillOpen).toBeDefined();
  expect(await resolveCommentRow(database, other.id, stillOpen!.id)).toBe(false);
  expect(await resolveCommentRow(database, user.id, stillOpen!.id)).toBe(true);
});

/**
 * The one rule the route's own code cannot prove: that a reader with no session is allowed as far
 * as the page at all. The matcher must leave `/share/` out of the gate, the handler must answer it
 * without a redirect and without a cache, and neither exemption may leak to anything else.
 */
it("lets a reader reach the share route without a session, and nothing else", async () => {
  const [gate, shared] = middlewareConfig.matcher;
  const gated = new RegExp(`^${gate}$`);
  expect(gated.test("/share/abc")).toBe(false);
  expect(gated.test("/cv/a-draft")).toBe(true);
  expect(shared).toBe("/share/:path*");

  const reader = await middleware(new NextRequest("https://ava.test/share/abc"));
  expect(reader.status).toBe(200);
  expect(reader.headers.get("location")).toBeNull();
  expect(reader.headers.get("cache-control")).toBe("private, no-store");
  const posting = await middleware(
    new NextRequest("https://ava.test/share/abc/comments", { method: "POST" }),
  );
  expect(posting.headers.get("location")).toBeNull();

  // Everything else without a session is still turned away, the API as an error and a page to login.
  const api = await middleware(new NextRequest("https://ava.test/api/work-status"));
  expect(api.status).toBe(401);
  const page = await middleware(new NextRequest("https://ava.test/cv/a-draft"));
  expect(page.headers.get("location")).toContain("/login");
});
