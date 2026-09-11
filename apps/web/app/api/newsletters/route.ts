import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { sha1, stripHtml } from "@christopher/core";
import { discoveryDocuments, discoverySources } from "@christopher/db/schema";
import { db } from "@/lib/db";
import { zUuid } from "@/lib/validation";

export const runtime = "nodejs";
const payloadSchema = z.object({ sourceId: zUuid(), title: z.string().trim().min(1).max(300), content: z.string().min(100).max(40000) });

/** Provider-neutral inbound email adapter. Does not grant access to a mailbox. */
export async function POST(request: Request): Promise<Response> {
  const secret = process.env.NEWSLETTER_INGEST_SECRET;
  if (!secret) return Response.json({ error: "Newsletter ingestion is not configured" }, { status: 503 });
  const expected = Buffer.from(`Bearer ${secret}`);
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return Response.json({ error: "Unauthorised" }, { status: 401 });
  // Bound actual streamed bytes, including requests without Content-Length.
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: "Body required" }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 500000) { await reader.cancel(); return Response.json({ error: "Content too large" }, { status: 413 }); }
    chunks.push(value);
  }
  let payload: z.infer<typeof payloadSchema>;
  try { payload = payloadSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
  catch { return Response.json({ error: "Expected sourceId, title and content (100–40,000 characters)" }, { status: 400 }); }
  const [source] = await db().select().from(discoverySources).where(eq(discoverySources.id, payload.sourceId));
  if (!source || source.kind !== "email") return Response.json({ error: "Email source not found" }, { status: 404 });
  const content = stripHtml(payload.content);
  if (content.length < 100) return Response.json({ error: "No readable newsletter content" }, { status: 400 });
  const rows = await db().insert(discoveryDocuments).values({ sourceId: source.id, title: payload.title, content,
    fingerprint: sha1(content),
  }).onConflictDoNothing().returning({ id: discoveryDocuments.id });
  return Response.json({ received: true, duplicate: rows.length === 0 }, { status: 202 });
}
