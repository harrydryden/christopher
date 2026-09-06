import { eq } from "drizzle-orm";
import { applications } from "@christopher/db";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { zUuid } from "@/lib/validation";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  if (!zUuid().safeParse(id).success) return new Response("Not found", { status: 404 });
  const [row] = await db().select({ pdf: applications.pdfBase64 }).from(applications).where(eq(applications.id, id));
  if (!row) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(Buffer.from(row.pdf, "base64")), { headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="submitted-CV.pdf"', "cache-control": "private, no-store" } });
}
