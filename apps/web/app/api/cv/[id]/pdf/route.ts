import { CvContentSchema } from "@col/core";
import { routeUser } from "@/lib/route-auth";
import { getOwnCvDraftForPdf } from "@/lib/queries/cv";
import { zUuid } from "@/lib/validation";
import { renderCvPdf, renderCvPdfWithReport, CvLayoutError } from "@/lib/cv-pdf";
import { refuseCvRender } from "@/lib/cv-render-limit";
import { storedFinalisedCvPdf } from "@/lib/cv-pdf-store";
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
  if (!preview && !draft.finalisedAt)
    return new Response("Review and finalise this CV before downloading.", { status: 409 });
  // Both preview and download of a finalised revision show the exact approved document. Only an
  // unfinished revision can render a new preview from its current wording.
  const stored = draft.finalisedAt ? await storedFinalisedCvPdf(user.id, draft.id) : null;
  if (draft.finalisedAt && !stored)
    return new Response("This final CV's saved PDF is unavailable. Create a new revision to review and finalise it again.", { status: 409 });
  let pdf: Buffer;
  if (stored) pdf = stored;
  else {
    if (!draft.content || (draft.status !== "ready" && !(preview && draft.status === "failed")))
      return new Response("CV is not ready", { status: 409 });
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
  }
  const candidateName = draft.content && typeof draft.content === "object" && "name" in draft.content && typeof draft.content.name === "string"
    ? draft.content.name : "CV";
  const filename = `${candidateName}-${draft.companyName}-CV`
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
