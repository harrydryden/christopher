import { assertCvFinalisable } from "@ava/core/cv-review";
import { CvContentSchema } from "@ava/core";
import { routeUser } from "@/lib/route-auth";
import { getOwnCvDraft } from "@/lib/queries/cv";
import { zUuid } from "@/lib/validation";
import { renderCvPdf, renderCvPdfWithReport, CvLayoutError } from "@/lib/cv-pdf";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await routeUser();
  if (!auth.ok) return auth.response;
  const user = auth.user;
  const { id } = await params;
  if (!zUuid().safeParse(id).success) return new Response("Not found", { status: 404 });
  const draft = await getOwnCvDraft(user.id, id);
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
  let pdf: Buffer;
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
