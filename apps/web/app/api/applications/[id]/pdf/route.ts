import { and, eq } from "drizzle-orm";
import { applications } from "@ava/db";
import { db } from "@/lib/db";
import { routeUser } from "@/lib/route-auth";
import { zUuid } from "@/lib/validation";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await routeUser();
  if (!auth.ok) return auth.response;
  const user = auth.user;
  const { id } = await params;
  if (!zUuid().safeParse(id).success) return new Response("Not found", { status: 404 });
  const [row] = await db().select({ pdf: applications.pdfBase64 }).from(applications).where(and(eq(applications.id, id), eq(applications.userId, user.id)));
  // `pdf_base64` is nullable: a stage recorded without a CV submitted through us has nothing to serve.
  if (!row?.pdf) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(Buffer.from(row.pdf, "base64")), { headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="submitted-CV.pdf"', "cache-control": "private, no-store" } });
}
