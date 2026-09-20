/**
 * A note left on a shared CV.
 *
 * The token is validated exactly as the page validates it — hashed, looked up, live or nothing —
 * because a link that has been ended must not still be writable. The anchor is then checked
 * against the ids of the revision that token actually opens, so a note is filed against a block
 * of this CV or it is not filed at all; nothing the sender supplied chooses a row.
 *
 * The owner stored on the note is the share's own `user_id`, never anything from this request:
 * that is what keeps a comment readable only by the account that owns the CV. And nothing written
 * here reaches a model call — a comment is data the owner reads, exactly as an imported document
 * is, never an instruction.
 */
import { NextResponse } from "next/server";
import { addCvShareComment, CvShareClosedError } from "@christopher/db";
import { db } from "@/lib/db";
import { isRateLimited, LIMITS, recordAttempt } from "@/lib/rate-limit";
import {
  CV_SHARE_COMMENT_BUSY_SENTENCE,
  CV_SHARE_GONE_SENTENCE,
  cvShareCommentKeys,
  cvShareCommentProblem,
  cvSharePath,
  hashCvShareToken,
  isCvShareAnchor,
  isCvShareToken,
  shareClientAddress,
} from "@/lib/cv-share";
import { sharedCvByToken } from "@/lib/queries/cv-shares";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A form post answers with a redirect, so a reload does not send the note twice.
 *
 * The location is relative and built from the token this route was called with — never from
 * `request.url`, whose host is whatever the runtime made of the proxy's forwarding. A reader
 * behind a proxy must come back to the host they typed, not to the one the server calls itself.
 */
function back(token: string, params: Record<string, string>, anchor = ""): NextResponse {
  const query = new URLSearchParams(params).toString();
  const location = `${cvSharePath(token)}${query ? `?${query}` : ""}${anchor ? `#${encodeURIComponent(anchor)}` : ""}`;
  return new NextResponse(null, {
    status: 303,
    headers: { location, "cache-control": "private, no-store" },
  });
}

/** The bodies that never get as far as a share: they carry no token worth looking up. */
function plain(sentence: string, status: number): NextResponse {
  return new NextResponse(sentence, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" },
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!token || !isCvShareToken(token)) return plain(CV_SHARE_GONE_SENTENCE, 404);

  const keys = cvShareCommentKeys(hashCvShareToken(token), shareClientAddress(request.headers));
  for (const key of keys) {
    if (await isRateLimited(key, LIMITS.shareComment)) return plain(CV_SHARE_COMMENT_BUSY_SENTENCE, 429);
  }
  for (const key of keys) await recordAttempt(key);

  const shared = await sharedCvByToken(token);
  if (!shared) return plain(CV_SHARE_GONE_SENTENCE, 404);
  if (!shared.allowComments) return back(token, { error: "comments_off" });

  const form = await request.formData();
  const anchor = String(form.get("anchor") ?? "");
  const authorName = String(form.get("authorName") ?? "");
  const body = String(form.get("body") ?? "");
  if (!isCvShareAnchor(anchor, shared.content)) return back(token, { error: "anchor" });
  if (cvShareCommentProblem(authorName, body)) return back(token, { error: "invalid" }, anchor);

  try {
    await addCvShareComment(db(), {
      shareId: shared.shareId,
      // The owner, as this route understands it: the account on the share row, checked again
      // inside the write against the share's own `user_id`.
      userId: shared.userId,
      anchor,
      authorName,
      body,
    });
  } catch (error) {
    if (error instanceof CvShareClosedError) {
      return back(token, { error: error.reason === "comments_off" ? "comments_off" : "gone" });
    }
    return back(token, { error: "invalid" }, anchor);
  }
  return back(token, { thanks: "1" }, anchor);
}
