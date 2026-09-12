import { CvContentSchema } from "@christopher/core/cv";
import { requireSession } from "@/lib/auth";
import { renderCvPdfWithReport, CvLayoutError } from "@/lib/cv-pdf";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A bounded, authenticated render only: no database writes and no AI calls. */
export async function POST(request: Request) {
  await requireSession();
  const reader = request.body?.getReader();
  if (!reader) return new Response("CV content is required.", { status: 400 });
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 150_000) { await reader.cancel(); return new Response("CV preview is too large.", { status: 413 }); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let payload: unknown;
  try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return new Response("Invalid CV content.", { status: 400 }); }
  const parsed = CvContentSchema.safeParse(payload);
  if (!parsed.success) return new Response(parsed.error.issues.map(issue => issue.message).join(" "), { status: 400 });
  let result;
  try { result = await renderCvPdfWithReport(parsed.data); }
  catch (error) {
    if (error instanceof CvLayoutError) return new Response(error.message, { status: 422 });
    throw error;
  }
  const { pdf, pageCount } = result;
  return new Response(new Uint8Array(pdf), { headers: {
    "content-type": "application/pdf", "content-disposition": 'inline; filename="cv-preview.pdf"',
    "cache-control": "private, no-store", "x-cv-page-count": String(pageCount),
  } });
}
