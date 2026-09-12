import { assertCvFinalisable } from "@christopher/core/cv-review";
import { eq } from "drizzle-orm";
import { cvDrafts } from "@christopher/db";
import { CvContentSchema } from "@christopher/core";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { zUuid } from "@/lib/validation";
import { renderCvPdf, CvLayoutError } from "@/lib/cv-pdf";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  if (!zUuid().safeParse(id).success) return new Response("Not found", { status: 404 });
  const [draft] = await db().select().from(cvDrafts).where(eq(cvDrafts.id, id));
  if (!draft) return new Response("Not found", { status: 404 });
  if (draft.status !== "ready" || !draft.content) return new Response("CV is not ready", { status: 409 });
  if (new URL(_request.url).searchParams.get("preview") !== "1") {
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
  try { pdf = await renderCvPdf(CvContentSchema.parse(draft.content)); }
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
      "content-disposition": `${new URL(_request.url).searchParams.get("preview") === "1" ? "inline" : "attachment"}; filename="${filename}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}
