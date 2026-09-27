/**
 * The PDF a revision was rendered to, kept so that it is rendered once rather than on every
 * download.
 *
 * Finalising renders the revision to prove it lays out, and used to throw the bytes away; the
 * download then rendered it again on every request (117 ms cold, 11–34 ms warm and about 26 MB of
 * RSS for a short CV, seconds for a long one), and recording an application rendered it a third
 * time. The bytes are now stored under the hash of what was rendered, and served while that hash
 * is still the revision's: content that changes, or a release whose renderer draws differently,
 * no longer matches, and the next request renders and stores again. Previews always render.
 *
 * `cv_pdfs` is a table of its own, not a column on `cv_drafts`: many reads select every column of
 * a draft, and a PDF is hundreds of kilobytes. Like `cv_tailoring_plans` it has no foreign key (a
 * delete trigger on `cv_drafts` takes a draft's PDF with it) and every read is scoped by the
 * account as well as the draft. The interface deploys apart from the worker that migrates, so a
 * database without the table reads as "nothing stored" and a store that fails is only logged:
 * neither can fail a download, a finalisation or a recorded application.
 */
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { cvPdfs } from "@ava/db/schema";
import { db } from "@/lib/db";

/**
 * Which renderer drew the bytes: the deployment's commit, so a release that changes the layout
 * re-renders a stored PDF on its first request instead of serving the old drawing.
 */
function rendererKey(): string {
  return process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.RENDER_GIT_COMMIT ?? "local";
}

/** The key a stored PDF is served under: what was rendered, and by which renderer. */
export function cvPdfContentHash(content: unknown): string {
  return createHash("sha256").update(rendererKey()).update("\n").update(JSON.stringify(content)).digest("hex");
}

function logStoreProblem(event: string, error: unknown) {
  console.warn(JSON.stringify({ event, message: error instanceof Error ? error.message : String(error) }));
}

/** The stored PDF for this account's draft, when it was rendered from exactly `contentHash`. */
export async function storedCvPdf(userId: string, draftId: string, contentHash: string): Promise<Buffer | null> {
  try {
    const [row] = await db()
      .select({ bytes: cvPdfs.bytes })
      .from(cvPdfs)
      .where(and(eq(cvPdfs.draftId, draftId), eq(cvPdfs.userId, userId), eq(cvPdfs.contentHash, contentHash)))
      .limit(1);
    return row?.bytes ?? null;
  } catch (error) {
    logStoreProblem("cv_pdf_read_failed", error);
    return null;
  }
}

/** Keep the bytes a render produced, replacing whatever the draft had stored before. */
export async function storeCvPdf(userId: string, draftId: string, contentHash: string, bytes: Buffer): Promise<void> {
  try {
    await db()
      .insert(cvPdfs)
      .values({ draftId, userId, contentHash, bytes })
      .onConflictDoUpdate({
        target: cvPdfs.draftId,
        set: { contentHash, bytes, createdAt: sql`now()` },
        // A draft is one account's; a row keyed by it under another account is never overwritten.
        setWhere: eq(cvPdfs.userId, userId),
      });
  } catch (error) {
    logStoreProblem("cv_pdf_store_failed", error);
  }
}

/**
 * The PDF for `content`: the stored bytes when they were drawn from exactly this, otherwise a
 * fresh render, which is then stored. `render` is passed in so that pdfkit is loaded only by the
 * callers that may need it.
 */
export async function cvPdfFor<T>(
  userId: string,
  draftId: string,
  content: T,
  render: (content: T) => Promise<Buffer>,
): Promise<{ pdf: Buffer; stored: boolean }> {
  const hash = cvPdfContentHash(content);
  const stored = await storedCvPdf(userId, draftId, hash);
  if (stored) return { pdf: stored, stored: true };
  const pdf = await render(content);
  await storeCvPdf(userId, draftId, hash, pdf);
  return { pdf, stored: false };
}
