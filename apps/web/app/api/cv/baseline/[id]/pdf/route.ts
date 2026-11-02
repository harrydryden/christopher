import { and, eq } from "drizzle-orm";
import { cvAutoBaselines } from "@col/db/schema";
import { CvContentSchema, CvLibrarySchema } from "@col/core/cv";
import { cvEmploymentDisplay } from "@col/core/cv-employment-display";
import { routeUser } from "@/lib/route-auth";
import { db } from "@/lib/db";
import { refuseCvRender } from "@/lib/cv-render-limit";
import { zUuid } from "@/lib/validation";
import { renderCvPdfWithReport, CvLayoutError } from "@/lib/cv-pdf";
import { CV_RENDER_VERSION } from "@col/core/cv-editing-modes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** A retained Auto artefact can be read after its generating draft has been pruned. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await routeUser();
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!zUuid().safeParse(id).success) return new Response("Not found", { status: 404 });
  const [baseline] = await db().select({ content: cvAutoBaselines.content,
    librarySnapshot: cvAutoBaselines.librarySnapshot, status: cvAutoBaselines.status,
    engineContract: cvAutoBaselines.engineContract })
    .from(cvAutoBaselines).where(and(eq(cvAutoBaselines.id, id), eq(cvAutoBaselines.userId, auth.user.id)));
  if (!baseline) return new Response("Not found", { status: 404 });
  if (baseline.status !== "ready" || !baseline.content || !baseline.librarySnapshot)
    return new Response("The Auto result is still being prepared.", { status: 409 });
  if (baseline.engineContract.render !== CV_RENDER_VERSION)
    return new Response("This saved Auto result was laid out by an earlier CV renderer. Update Auto or fork a new edition to review its PDF.", { status: 409 });
  const refused = await refuseCvRender(auth.user.id);
  if (refused) return refused;
  try {
    const content = CvContentSchema.parse(baseline.content);
    const library = CvLibrarySchema.parse(baseline.librarySnapshot);
    const result = await renderCvPdfWithReport(content, cvEmploymentDisplay(content, library));
    return new Response(new Uint8Array(result.pdf), { headers: {
      "content-type": "application/pdf", "content-disposition": 'inline; filename="auto-cv.pdf"',
      "cache-control": "private, no-store", "x-cv-page-count": String(result.pageCount),
    } });
  } catch (error) {
    if (error instanceof CvLayoutError) return new Response(error.message, { status: 422 });
    throw error;
  }
}
