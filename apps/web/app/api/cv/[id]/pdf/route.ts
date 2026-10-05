import { assertCvFinalisable } from "@col/core/cv-review";
import { CvContentSchema } from "@col/core";
import { routeUser } from "@/lib/route-auth";
import { getOwnCvDraftForPdf } from "@/lib/queries/cv";
import { zUuid } from "@/lib/validation";
import { renderCvPdf, renderCvPdfWithReport, CvLayoutError } from "@/lib/cv-pdf";
import { refuseCvRender } from "@/lib/cv-render-limit";
import { cvPdfContentHash, storeCvPdf, storedCvPdf } from "@/lib/cv-pdf-store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A CV renders in about a second, bounded by `cv-render-limit.ts`; a pathological document is cut off at 30 s of function time instead of the platform default of 300.
export const maxDuration = 30;
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await routeUser();
  if (!auth.ok) return auth.response;
  const user = auth.user;
  const { id } = await params;
  if (!zUuid().safeParse(id).success) return new Response("Not found", { status: 404 });
  const draft = await getOwnCvDraftForPdf(user.id, id);
  if (!draft) return new Response("Not found", { status: 404 });
  const preview = new URL(_request.url).searchParams.get("preview") === "1";
  if (!draft.content || (draft.status !== "ready" && !(preview && draft.status === "failed"))) return new Response("CV is not ready", { status: 409 });
  if (!preview) {
    try {
      if (!draft.finalisedAt)
        throw new Error(
          "Review the assessment and finalise this CV before downloading.",
        );
      assertCvFinalisable({ ...draft, content: draft.content });
    } catch (error) {
      return new Response(
        error instanceof Error ? error.message : "Assessment required",
        { status: 409 },
      );
    }
  }
  // A download of a finalised revision serves the bytes finalising rendered, while they were drawn
  // from exactly this content by this release's renderer; it renders only when they were not, and
  // then keeps what it rendered. Serving stored bytes is not a render, so it is not counted against
  // the account's render allowance. A preview always renders.
  const hash = preview ? null : cvPdfContentHash(draft.content);
  const stored = hash ? await storedCvPdf(user.id, draft.id, hash) : null;
  let pdf: Buffer;
  if (stored) pdf = stored;
  else {
    const refused = await refuseCvRender(user.id);
    if (refused) return refused;
    try {
      const content = CvContentSchema.parse(draft.content);
      pdf = preview
        ? (await renderCvPdfWithReport(content)).pdf
        : await renderCvPdf(content);
    }
    catch (error) {
      if (error instanceof CvLayoutError) return new Response(error.message, { status: 422 });
      throw error;
    }
    if (hash) await storeCvPdf(user.id, draft.id, hash, pdf);
  }
  const filename = `${draft.content.name}-${draft.companyName}-CV`
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .slice(0, 100);
  return new Response(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `${preview ? "inline" : "attachment"}; filename="${filename}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}
