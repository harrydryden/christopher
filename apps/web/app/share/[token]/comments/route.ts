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
import { addCvShareComment, CvShareClosedError } from "@ava/db";
import { db } from "@/lib/db";
import { consumeRateLimit, LIMITS } from "@/lib/rate-limit";
import {
  CV_SHARE_COMMENT_BUSY_SENTENCE,
  CV_SHARE_COMMENT_REQUEST_MAX_BYTES,
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

/** Read a public multipart request with a real byte cap, including chunked or dishonest bodies. */
async function boundedFormData(request: Request): Promise<FormData | NextResponse> {
  const stated = request.headers.get("content-length");
  if (stated !== null) {
    const bytes = Number(stated);
    if (!Number.isSafeInteger(bytes) || bytes < 0) return plain("That note could not be read.", 400);
    if (bytes > CV_SHARE_COMMENT_REQUEST_MAX_BYTES) return plain("That note is too large to send.", 413);
  }
  const reader = request.body?.getReader();
  if (!reader) return plain("That note could not be read.", 400);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > CV_SHARE_COMMENT_REQUEST_MAX_BYTES) {
        await reader.cancel();
        return plain("That note is too large to send.", 413);
      }
      chunks.push(value);
    }
  } catch {
    return plain("That note could not be read.", 400);
  } finally {
    reader.releaseLock();
  }
  const contentType = request.headers.get("content-type");
  if (!contentType) return plain("That note could not be read.", 400);
  try {
    return await new Response(Buffer.concat(chunks), { headers: { "content-type": contentType } }).formData();
  } catch {
    return plain("That note could not be read.", 400);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!token || !isCvShareToken(token)) return plain(CV_SHARE_GONE_SENTENCE, 404);

  const parsed = await boundedFormData(request);
  if (parsed instanceof NextResponse) return parsed;

  const keys = cvShareCommentKeys(hashCvShareToken(token), shareClientAddress(request.headers));
  if (!(await consumeRateLimit(keys, LIMITS.shareComment))) return plain(CV_SHARE_COMMENT_BUSY_SENTENCE, 429);

  const shared = await sharedCvByToken(token);
  if (!shared) return plain(CV_SHARE_GONE_SENTENCE, 404);
  if (!shared.allowComments) return back(token, { error: "comments_off" });

  const form = parsed;
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
