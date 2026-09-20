/**
 * Share links for a CV preview, and the notes readers leave on one.
 *
 * Two rules shape every function here. The token is never stored: the caller generates it, hashes
 * it, and keeps the plain string only long enough to put it in a link, exactly as `auth_tokens`
 * does — so a database backup cannot reconstruct anyone's link. And the share row is what carries
 * the account through a route that has no session: `findLiveCvShareByHash` turns a token into an
 * owner and a draft, and every read after that is scoped by that `userId`, which is how a public
 * page obeys the rule that per-account data is never read without one.
 *
 * A share is live only while it is neither revoked nor expired, and this file is the only place
 * that decides it. The same questions gate a comment, so a link that has been ended cannot still
 * be written to.
 */
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "./client";
import {
  cvShareComments, cvShares, CV_SHARE_ANCHOR_MAX_CHARS, CV_SHARE_AUTHOR_NAME_MAX_CHARS,
  CV_SHARE_BODY_MAX_CHARS, type CvShare, type CvShareComment,
} from "./schema";

/** Why a link would take no comment. The interface writes its own sentences; this is the reason it writes them from. */
export type CvShareRefusal = "missing" | "revoked" | "expired" | "comments_off";

const REFUSAL_MESSAGES: Record<CvShareRefusal, string> = {
  missing: "This link is no longer a share.",
  revoked: "This link has been revoked.",
  expired: "This link has expired.",
  comments_off: "This link does not take comments.",
};

/** Thrown by `addCvShareComment` when the link cannot take one. `reason` is the contract; the message is a fallback. */
export class CvShareClosedError extends Error {
  readonly reason: CvShareRefusal;
  constructor(reason: CvShareRefusal) {
    super(REFUSAL_MESSAGES[reason]);
    this.name = "CvShareClosedError";
    this.reason = reason;
  }
}

export interface CreateCvShareInput {
  /** The owner of the CV: the account every read through this link is scoped by. */
  userId: string;
  draftId: string;
  /** sha256 (or equal) of the token in the link. The plain token is the caller's to send and is never stored. */
  tokenHash: string;
  /** Default true; false makes the link read-only. */
  allowComments?: boolean;
  expiresAt: Date;
}

/**
 * Open a link onto one CV preview.
 *
 * The caller generates the token, hashes it and passes the hash: nothing here can recover the
 * plain token, and nothing here should be able to. `expiresAt` is the caller's policy (fourteen
 * days in the interface); a share that is already past it is simply never live.
 */
export async function createCvShare(db: Db, input: CreateCvShareInput, now = new Date()): Promise<CvShare> {
  const [row] = await db
    .insert(cvShares)
    .values({
      userId: input.userId,
      draftId: input.draftId,
      tokenHash: input.tokenHash,
      allowComments: input.allowComments ?? true,
      expiresAt: input.expiresAt,
      createdAt: now,
    })
    .returning();
  if (!row) throw new Error("createCvShare: the share was not created");
  return row;
}

/** What a token buys: the owner to scope the read by, the draft to render, and whether notes are taken. */
export interface LiveCvShare {
  id: string;
  /** The owner. Every read the shared page makes is scoped by this and nothing the visitor supplied. */
  userId: string;
  draftId: string;
  allowComments: boolean;
  expiresAt: Date;
}

/**
 * The share a token stands for, when it still stands for one.
 *
 * Null when no share has that hash, when it was revoked, or when it has expired — the caller
 * cannot tell those apart, and should not: an unknown link and an ended one look the same from
 * outside. The projection is deliberately small; the token hash and the view counters are the
 * owner's business, not the reader's page.
 */
export async function findLiveCvShareByHash(db: Db, tokenHash: string, now = new Date()): Promise<LiveCvShare | null> {
  const [row] = await db
    .select({
      id: cvShares.id,
      userId: cvShares.userId,
      draftId: cvShares.draftId,
      allowComments: cvShares.allowComments,
      expiresAt: cvShares.expiresAt,
    })
    .from(cvShares)
    .where(and(eq(cvShares.tokenHash, tokenHash), isNull(cvShares.revokedAt), gt(cvShares.expiresAt, now)))
    .limit(1);
  return row ?? null;
}

/**
 * Note that the link was opened. No `userId`: the id came from a token lookup that already decided
 * the share is live, and the counter is the owner's evidence that their reviewer actually read it.
 */
export async function recordCvShareView(db: Db, id: string, now = new Date()): Promise<void> {
  await db
    .update(cvShares)
    .set({ viewCount: sql`${cvShares.viewCount} + 1`, lastViewedAt: now })
    .where(eq(cvShares.id, id));
}

/** Every link this account has opened onto one of its CVs, newest first, live or not. */
export async function listCvShares(db: Db, userId: string, draftId: string): Promise<CvShare[]> {
  return db
    .select()
    .from(cvShares)
    .where(and(eq(cvShares.userId, userId), eq(cvShares.draftId, draftId)))
    .orderBy(desc(cvShares.createdAt));
}

/**
 * End a link now. Scoped by account, and true only when this call was the one that ended it, so a
 * second click does not read as a second revocation. Comments already left are kept: they are the
 * owner's, and revoking is about the link, not about the notes.
 */
export async function revokeCvShare(db: Db, userId: string, id: string, now = new Date()): Promise<boolean> {
  const moved = await db
    .update(cvShares)
    .set({ revokedAt: now })
    .where(and(eq(cvShares.id, id), eq(cvShares.userId, userId), isNull(cvShares.revokedAt)))
    .returning({ id: cvShares.id });
  return moved.length > 0;
}

export interface AddCvShareCommentInput {
  shareId: string;
  /** The owner, as the caller understands it. Checked against the share, which is what is stored. */
  userId: string;
  /** The block the note is about: the profile block or a section block id the assessment also cites. */
  anchor: string;
  authorName: string;
  body: string;
}

/**
 * Leave a note on a shared CV.
 *
 * Refuses with a `CvShareClosedError` when the link is unknown, revoked, expired, or was opened
 * read-only: a link that has been ended cannot still be written to, and the reason is on the error
 * so the page can say which it was. The owner stored on the comment is the share's own `user_id`,
 * never the caller's claim — a mismatch is a bug and throws — because every later read of that
 * comment is scoped by it.
 *
 * Lengths are checked here as well as by the column constraints, so a note that is too long is a
 * sentence the interface can show rather than a constraint violation. Whitespace is trimmed first.
 */
export async function addCvShareComment(db: Db, input: AddCvShareCommentInput, now = new Date()): Promise<CvShareComment> {
  const anchor = input.anchor.trim();
  const authorName = input.authorName.trim();
  const body = input.body.trim();
  if (!anchor || anchor.length > CV_SHARE_ANCHOR_MAX_CHARS) throw new Error("addCvShareComment: the anchor is missing or too long");
  if (!authorName || authorName.length > CV_SHARE_AUTHOR_NAME_MAX_CHARS) throw new Error(`addCvShareComment: a name is required, at most ${CV_SHARE_AUTHOR_NAME_MAX_CHARS} characters`);
  if (!body || body.length > CV_SHARE_BODY_MAX_CHARS) throw new Error(`addCvShareComment: a note is required, at most ${CV_SHARE_BODY_MAX_CHARS} characters`);

  return db.transaction(async (tx) => {
    const [share] = await tx
      .select({ userId: cvShares.userId, allowComments: cvShares.allowComments, expiresAt: cvShares.expiresAt, revokedAt: cvShares.revokedAt })
      .from(cvShares)
      .where(eq(cvShares.id, input.shareId))
      .limit(1);
    if (!share) throw new CvShareClosedError("missing");
    if (share.revokedAt) throw new CvShareClosedError("revoked");
    if (share.expiresAt.getTime() <= now.getTime()) throw new CvShareClosedError("expired");
    if (!share.allowComments) throw new CvShareClosedError("comments_off");
    if (share.userId !== input.userId) throw new Error("addCvShareComment: the share belongs to another account");
    const [row] = await tx
      .insert(cvShareComments)
      .values({ shareId: input.shareId, userId: share.userId, anchor, authorName, body, createdAt: now })
      .returning();
    if (!row) throw new Error("addCvShareComment: the comment was not stored");
    return row;
  });
}

/**
 * Every note left on one CV, from all of its links, newest first and flat: the owner groups them by
 * anchor for the Evaluation tab, and a thread per link is not a thing anyone asked for. Scoped by
 * account, which the comment carries itself, and by the draft, which its share does. Capped, since
 * this feeds a page.
 */
export async function listCvShareComments(db: Db, userId: string, draftId: string, limit = 200): Promise<CvShareComment[]> {
  return db
    .select({
      id: cvShareComments.id,
      shareId: cvShareComments.shareId,
      userId: cvShareComments.userId,
      anchor: cvShareComments.anchor,
      authorName: cvShareComments.authorName,
      body: cvShareComments.body,
      createdAt: cvShareComments.createdAt,
      resolvedAt: cvShareComments.resolvedAt,
    })
    .from(cvShareComments)
    .innerJoin(cvShares, eq(cvShareComments.shareId, cvShares.id))
    .where(and(eq(cvShareComments.userId, userId), eq(cvShares.draftId, draftId)))
    .orderBy(desc(cvShareComments.createdAt))
    .limit(Math.max(1, Math.floor(limit)));
}

/**
 * The owner has dealt with a note. Theirs to do and no one else's, so it is scoped by account, and
 * true only when this call was the one that resolved it.
 */
export async function resolveCvShareComment(db: Db, userId: string, id: string, now = new Date()): Promise<boolean> {
  const moved = await db
    .update(cvShareComments)
    .set({ resolvedAt: now })
    .where(and(eq(cvShareComments.id, id), eq(cvShareComments.userId, userId), isNull(cvShareComments.resolvedAt)))
    .returning({ id: cvShareComments.id });
  return moved.length > 0;
}

/** How many notes on this CV are still open: the count beside the Evaluation tab. */
export async function countOpenCvShareComments(db: Db, userId: string, draftId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(cvShareComments)
    .innerJoin(cvShares, eq(cvShareComments.shareId, cvShares.id))
    .where(and(eq(cvShareComments.userId, userId), eq(cvShares.draftId, draftId), isNull(cvShareComments.resolvedAt)));
  return row?.n ?? 0;
}
