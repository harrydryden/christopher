/**
 * What a share link is, before any of it touches the database.
 *
 * Everything here is a pure decision about one link: how its token is made and hashed, how long
 * it may live, which blocks of a CV a note may be left against, and the sentences the public page
 * says when the answer is no. The reads and writes live in `lib/queries/cv-shares.ts` and
 * `@christopher/db`; keeping the rules here is what lets them be tested without a database, and
 * what stops the same cap being written twice in a form and a route handler.
 *
 * Two of these rules are load-bearing. The token is generated and hashed exactly as `auth_tokens`
 * does and only its hash is ever stored, so the link in a reviewer's inbox cannot be recovered
 * from a backup. And an anchor is checked against the ids of the CV actually being read, never
 * accepted because it looks well formed — a note is filed against a block of this revision or it
 * is not filed at all.
 */
import { randomBytes } from "node:crypto";
import {
  CV_SHARE_ANCHOR_MAX_CHARS,
  CV_SHARE_AUTHOR_NAME_MAX_CHARS,
  CV_SHARE_BODY_MAX_CHARS,
} from "@christopher/db/schema";
import type { CvShareRefusal } from "@christopher/db";
import { cvDisplaySections, type CvContent } from "@christopher/core/cv";
import { CV_PROFILE_ID, cvSectionBlockId, type CvContentLink } from "./cv-content-links";
import { hashToken } from "./auth-tokens";

export { CV_SHARE_ANCHOR_MAX_CHARS, CV_SHARE_AUTHOR_NAME_MAX_CHARS, CV_SHARE_BODY_MAX_CHARS };

/** The same 32 bytes `issueAuthToken` draws, in the same alphabet: 43 URL-safe characters. */
const TOKEN_BYTES = 32;

/** What a token may look like before it is worth hashing: the shape `newCvShareToken` produces. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,200}$/;

export function newCvShareToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** The stored form of a link nobody can reverse: the same hashing the single-use auth links use. */
export function hashCvShareToken(token: string): string {
  return hashToken(token);
}

/**
 * Whether a path segment could be one of our tokens. A cheap shape check in front of the lookup,
 * so a crawler walking `/share/<anything>` costs a regex rather than a query.
 */
export function isCvShareToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

/** The interface's policy, not the database's: a fortnight by default, three months at the most. */
export const CV_SHARE_DEFAULT_DAYS = 14;
export const CV_SHARE_MIN_DAYS = 1;
export const CV_SHARE_MAX_DAYS = 90;
/** What the form offers. Any day count inside the bounds is accepted; these are the ones named. */
export const CV_SHARE_DAY_CHOICES = [7, 14, 30, 90] as const;

/** A submitted expiry, brought inside the bounds rather than refused: a link is not worth an error. */
export function cvShareDays(value: unknown): number {
  const days = Math.floor(Number(typeof value === "string" ? value.trim() : value));
  if (!Number.isFinite(days) || days <= 0) return CV_SHARE_DEFAULT_DAYS;
  return Math.min(CV_SHARE_MAX_DAYS, Math.max(CV_SHARE_MIN_DAYS, days));
}

export function cvShareExpiry(value: unknown, now: Date = new Date()): Date {
  return new Date(now.getTime() + cvShareDays(value) * 24 * 60 * 60 * 1000);
}

/** The path the owner copies. Relative, so it works whatever host the deployment answers on. */
export function cvSharePath(token: string): string {
  return `/share/${encodeURIComponent(token)}`;
}

/**
 * Every block of this revision a note may be left against, in the order the page shows them: the
 * profile first, then the sections in display order. These are the ids the assessment already
 * cites, so a reader's note and a reviewer's finding land on the same text.
 */
export function cvShareAnchors(content: CvContent | null | undefined): CvContentLink[] {
  if (!content) return [];
  return [
    { id: CV_PROFILE_ID, label: "Profile" },
    ...cvDisplaySections(content).map(({ section }) => ({
      id: cvSectionBlockId(section.entryId),
      label: section.heading,
    })),
  ];
}

/**
 * Whether a submitted anchor is one of this CV's own blocks.
 *
 * The cap is checked first so a megabyte of "anchor" is refused before it is compared, and the
 * membership test is what actually decides: an id that is not in this revision is not an anchor,
 * however well formed it looks.
 */
export function isCvShareAnchor(anchor: string, content: CvContent | null | undefined): boolean {
  if (!anchor || anchor.length > CV_SHARE_ANCHOR_MAX_CHARS) return false;
  return cvShareAnchors(content).some((block) => block.id === anchor);
}

/** What to call a block in a sentence: its heading, or "This CV" for a note filed against nothing. */
export function cvShareAnchorLabel(anchor: string, content: CvContent | null | undefined): string {
  return cvShareAnchors(content).find((block) => block.id === anchor)?.label ?? "This CV";
}

/** Whether a name and a note are sayable, in the sentence the reader should read. Null when they are. */
export function cvShareCommentProblem(authorName: string, body: string): string | null {
  const name = authorName.trim();
  const note = body.trim();
  if (!name) return "Add your name so the owner knows who left this note.";
  if (name.length > CV_SHARE_AUTHOR_NAME_MAX_CHARS)
    return `Names are at most ${CV_SHARE_AUTHOR_NAME_MAX_CHARS} characters.`;
  if (!note) return "Write a note before sending it.";
  if (note.length > CV_SHARE_BODY_MAX_CHARS)
    return `Notes are at most ${CV_SHARE_BODY_MAX_CHARS.toLocaleString("en-GB")} characters.`;
  return null;
}

export type CvShareState = "live" | "revoked" | "expired";

/** What a link is now, for the owner's list. The reader's page never asks: it only asks if it is live. */
export function cvShareState(
  share: { revokedAt: Date | null; expiresAt: Date },
  now: Date = new Date(),
): CvShareState {
  if (share.revokedAt) return "revoked";
  return share.expiresAt.getTime() <= now.getTime() ? "expired" : "live";
}

/** One sentence, whatever went wrong: an unknown link and an ended one look the same from outside. */
export const CV_SHARE_GONE_SENTENCE = "This link has expired or was withdrawn.";
export const CV_SHARE_BUSY_SENTENCE =
  "This link has been opened too many times just now. Wait a few minutes and try again.";
export const CV_SHARE_COMMENT_BUSY_SENTENCE =
  "Too many notes have been sent through this link just now. Wait a few minutes and try again.";
export const CV_SHARE_THANKS_SENTENCE = "Thank you. Your note is with the owner of this CV.";
export const CV_SHARE_ANCHOR_SENTENCE = "That note could not be filed against this CV. Try again.";

/** The reader's sentence for each way a link refuses a note. `comments_off` is the only one they can act on. */
const REFUSAL_SENTENCES: Record<CvShareRefusal, string> = {
  missing: CV_SHARE_GONE_SENTENCE,
  revoked: CV_SHARE_GONE_SENTENCE,
  expired: CV_SHARE_GONE_SENTENCE,
  comments_off: "This link is read-only, so it does not take notes.",
};

export function cvShareRefusalSentence(reason: CvShareRefusal): string {
  return REFUSAL_SENTENCES[reason];
}

/** The error codes the comments route hands back in the query string, and what each one says. */
export const CV_SHARE_ERROR_SENTENCES: Record<string, string> = {
  gone: CV_SHARE_GONE_SENTENCE,
  comments_off: REFUSAL_SENTENCES.comments_off,
  anchor: CV_SHARE_ANCHOR_SENTENCE,
  busy: CV_SHARE_COMMENT_BUSY_SENTENCE,
  invalid: "That note could not be sent. Check your name and note, then try again.",
};

/**
 * Who is asking, for the rate limit: the first hop in `x-forwarded-for`, then the proxy's own
 * header, then a constant — so a request with no address is throttled as one caller rather than
 * as nobody. The same rule `clientAddress()` applies to sign-in, kept here because this route has
 * no session module behind it.
 */
export function shareClientAddress(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (forwarded || headers.get("x-real-ip") || "unknown").slice(0, 100);
}

/** The `login_attempts` keys this feature counts against: one per link, one per caller. */
export const cvShareViewKeys = (tokenHash: string, address: string) => [
  `share:token:${tokenHash}`,
  `share:ip:${address}`,
];
export const cvShareCommentKeys = (tokenHash: string, address: string) => [
  `share-comment:token:${tokenHash}`,
  `share-comment:ip:${address}`,
];

/**
 * What `createCvShareLink` hands back. The plain token exists for exactly one response — it is
 * never stored and never read again — so the link travels on the result rather than being fetched
 * from a page the owner might reload.
 */
export type CvShareResult =
  | { ok: true; message?: string; link?: string; expiresAt?: string }
  | { ok: false; error: string };

export interface CvShareCommentLike {
  anchor: string;
  resolvedAt: Date | null;
}

/** How many open notes sit on each block, for the count beside it in the Content tab. */
export function openCommentCounts(comments: CvShareCommentLike[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const comment of comments) {
    if (comment.resolvedAt) continue;
    counts[comment.anchor] = (counts[comment.anchor] ?? 0) + 1;
  }
  return counts;
}
