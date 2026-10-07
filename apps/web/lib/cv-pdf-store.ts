/** The immutable PDF saved in the same transaction that finalises a CV revision. */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { cvPdfs } from "@col/db/schema";
import { db } from "@/lib/db";

/** Records which renderer produced the approved bytes. Later releases still serve those bytes. */
function rendererKey(): string {
  return process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.RENDER_GIT_COMMIT ?? "local";
}

/** Provenance for the PDF rendered at finalisation, including its renderer. */
export function cvPdfContentHash(content: unknown): string {
  return createHash("sha256").update(rendererKey()).update("\n").update(JSON.stringify(content)).digest("hex");
}

function logStoreProblem(event: string, error: unknown) {
  console.warn(JSON.stringify({ event, message: error instanceof Error ? error.message : String(error) }));
}

/**
 * The PDF frozen when this owned revision was finalised. A later renderer or review version must
 * not change the document the person approved. Callers must first establish `finalisedAt` and
 * must never use these bytes as a preview of unsaved edits.
 */
export async function storedFinalisedCvPdf(userId: string, draftId: string): Promise<Buffer | null> {
  try {
    const [row] = await db()
      .select({ bytes: cvPdfs.bytes })
      .from(cvPdfs)
      .where(and(eq(cvPdfs.draftId, draftId), eq(cvPdfs.userId, userId)))
      .limit(1);
    return row?.bytes ?? null;
  } catch (error) {
    logStoreProblem("cv_final_pdf_read_failed", error);
    return null;
  }
}

/** Cheap availability check for a finalised revision's command area. */
export async function hasStoredFinalisedCvPdf(userId: string, draftId: string): Promise<boolean> {
  try {
    const [row] = await db()
      .select({ draftId: cvPdfs.draftId })
      .from(cvPdfs)
      .where(and(eq(cvPdfs.draftId, draftId), eq(cvPdfs.userId, userId)))
      .limit(1);
    return !!row;
  } catch (error) {
    logStoreProblem("cv_final_pdf_check_failed", error);
    return false;
  }
}
