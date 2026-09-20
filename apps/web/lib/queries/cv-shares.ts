/**
 * The reads behind a share link, on both sides of it.
 *
 * `sharedCvByToken` is the one place in the interface where a read is not behind a session, and
 * the shape of it is the reason that is safe: the token buys a share row, the share row carries
 * the owner's `userId`, and every read after that is scoped by that account and by the draft the
 * share names. Nothing the visitor supplied reaches a `where` clause except the token hash.
 *
 * The draft is projected to its content and nothing else. `job_description`, `library_snapshot`
 * and `assessment` live on the same row — the advert the person is answering, their whole evidence
 * library, and the reviewer's findings — and none of them belongs to the reader. Selecting the two
 * columns the page needs is what keeps them out, rather than a rule about what to render.
 */
import { and, eq, isNull } from "drizzle-orm";
import {
  countOpenCvShareComments,
  findLiveCvShareByHash,
  listCvShareComments,
  listCvShares,
  type CvShare,
  type CvShareComment,
} from "@christopher/db";
import { cvDrafts, cvShareComments } from "@christopher/db/schema";
import type { CvContent } from "@christopher/core/cv";
import { db } from "@/lib/db";
import { hashCvShareToken, isCvShareToken } from "@/lib/cv-share";

/** What a live link is worth: one revision's content, and the notes already left through it. */
export interface SharedCv {
  shareId: string;
  /** The owner. Every read this page made was scoped by it; the reader never sees it. */
  userId: string;
  draftId: string;
  allowComments: boolean;
  expiresAt: Date;
  content: CvContent;
  /** Notes left through this same link, oldest first, so a thread reads downwards. */
  comments: Pick<CvShareComment, "id" | "anchor" | "authorName" | "body" | "createdAt">[];
}

/** How many notes one shared page will show. A link is for a reading, not for a forum. */
const COMMENT_LIMIT = 200;

/**
 * The CV a token stands for, or null when it stands for none.
 *
 * Null covers every way this can end — an unknown token, a revoked or expired share, a draft that
 * has since been archived or deleted, a build that never produced content — because from outside
 * they are one answer: the link no longer works. A share is of one revision, so an archived draft
 * takes its links with it rather than quietly following the person's newer CV.
 */
export async function sharedCvByToken(token: string, now: Date = new Date()): Promise<SharedCv | null> {
  if (!isCvShareToken(token)) return null;
  const share = await findLiveCvShareByHash(db(), hashCvShareToken(token), now);
  if (!share) return null;
  const [draft] = await db()
    .select({ content: cvDrafts.content })
    .from(cvDrafts)
    .where(and(eq(cvDrafts.id, share.draftId), eq(cvDrafts.userId, share.userId), isNull(cvDrafts.archivedAt)))
    .limit(1);
  if (!draft?.content) return null;
  // This link's own thread, not the draft's: two reviewers given two links see their own notes.
  const comments = await db()
    .select({
      id: cvShareComments.id,
      anchor: cvShareComments.anchor,
      authorName: cvShareComments.authorName,
      body: cvShareComments.body,
      createdAt: cvShareComments.createdAt,
    })
    .from(cvShareComments)
    .where(and(eq(cvShareComments.userId, share.userId), eq(cvShareComments.shareId, share.id)))
    .orderBy(cvShareComments.createdAt)
    .limit(COMMENT_LIMIT);
  return {
    shareId: share.id,
    userId: share.userId,
    draftId: share.draftId,
    allowComments: share.allowComments,
    expiresAt: share.expiresAt,
    content: draft.content,
    comments,
  };
}

/** Every link this account has opened onto one of its CVs, newest first, live or not. */
export async function getOwnCvShares(userId: string, draftId: string): Promise<CvShare[]> {
  return listCvShares(db(), userId, draftId);
}

/** Every note left on one of this account's CVs, from all of its links, newest first. */
export async function getOwnCvShareComments(userId: string, draftId: string): Promise<CvShareComment[]> {
  return listCvShareComments(db(), userId, draftId);
}

/** How many of them are still open: the count beside the Evaluation tab and each content block. */
export async function countOwnOpenCvShareComments(userId: string, draftId: string): Promise<number> {
  return countOpenCvShareComments(db(), userId, draftId);
}

/**
 * Everything the CV workspace needs to talk about sharing, in one round trip: the links, the
 * notes, and how many of the notes are still open. All three are scoped by the account and the
 * draft, as every per-account read is.
 *
 * `openCount` is counted in the database rather than over `comments`, because the list is capped
 * and a heading that says "3 open" while the list shows two hundred would be the cap talking, not
 * the truth.
 */
export async function getOwnCvSharing(userId: string, draftId: string): Promise<{
  shares: CvShare[];
  comments: CvShareComment[];
  openCount: number;
}> {
  const [shares, comments, openCount] = await Promise.all([
    getOwnCvShares(userId, draftId),
    getOwnCvShareComments(userId, draftId),
    countOwnOpenCvShareComments(userId, draftId),
  ]);
  return { shares, comments, openCount };
}
