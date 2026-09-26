import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { isImportOnlyKind, sha1, stripHtml } from "@ava/core";
import { discoveryDocuments, discoverySources } from "@ava/db/schema";
import { db } from "@/lib/db";
import { consumeRateLimit, LIMITS } from "@/lib/rate-limit";
import { zUuid } from "@/lib/validation";
import { sourceIdForAddress } from "@/lib/newsletter-address";

export const runtime = "nodejs";
/**
 * Two ways in. A forwarding rule that knows the source posts `sourceId`. A mail provider that
 * simply delivers whatever arrived posts the recipient as `to`, and the source is resolved from
 * the address. Common provider field names are accepted for the subject and body.
 */
const payloadSchema = z.object({
  sourceId: zUuid().optional(),
  to: z.string().trim().min(3).max(320).optional(),
  title: z.string().trim().min(1).max(300).optional(),
  subject: z.string().trim().min(1).max(300).optional(),
  content: z.string().max(200000).optional(),
  text: z.string().max(200000).optional(),
  html: z.string().max(200000).optional(),
}).refine((p) => p.sourceId || p.to, { message: "sourceId or to is required" });

/**
 * Provider-neutral inbound email adapter. Does not grant access to a mailbox.
 *
 * The bearer is one secret for the whole deployment, held by the operator's relay, so it can write
 * into any account's email source whose id it is given; a per-source token needs a column the
 * schema does not have yet. Until then each source takes a bounded number of documents a day,
 * because every one is later read by the model on its owner's budget.
 */
export async function POST(request: Request): Promise<Response> {
  const secret = process.env.NEWSLETTER_INGEST_SECRET;
  if (!secret) return Response.json({ ok: false, error: "Newsletter ingestion is not configured" }, { status: 503 });
  const expected = Buffer.from(`Bearer ${secret}`);
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return Response.json({ ok: false, error: "Unauthorised" }, { status: 401 });
  // Bound actual streamed bytes, including requests without Content-Length.
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ ok: false, error: "Body required" }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 500000) { await reader.cancel(); return Response.json({ ok: false, error: "Content too large" }, { status: 413 }); }
    chunks.push(value);
  }
  let payload: z.infer<typeof payloadSchema>;
  let body: string;
  let title: string;
  try {
    payload = payloadSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    body = payload.content ?? payload.text ?? payload.html ?? "";
    title = (payload.title ?? payload.subject ?? "").trim();
    if (!title || body.length < 100) throw new Error();
  } catch { return Response.json({ ok: false, error: "Expected sourceId or to, a title or subject, and content of at least 100 characters" }, { status: 400 }); }

  let sourceId = payload.sourceId ?? null;
  if (!sourceId && payload.to) {
    const rows = await db().select({ id: discoverySources.id }).from(discoverySources);
    sourceId = sourceIdForAddress(payload.to, rows.map((r) => r.id), secret);
  }
  if (!sourceId) return Response.json({ ok: false, error: "No source is subscribed at that address" }, { status: 404 });
  const [source] = await db().select().from(discoverySources).where(eq(discoverySources.id, sourceId));
  // Website sources are read by fetching them; only a hand-fed source accepts delivered editions.
  if (!source || !isImportOnlyKind(source.kind)) return Response.json({ ok: false, error: "Email source not found" }, { status: 404 });
  if (!(await consumeRateLimit([`newsletter:source:${source.id}`], LIMITS.newsletterSource))) {
    return Response.json({ ok: false, error: "Too many newsletters for this source today" }, { status: 429 });
  }
  const content = stripHtml(body).slice(0, 40000);
  if (content.length < 100) return Response.json({ ok: false, error: "No readable newsletter content" }, { status: 400 });
  const rows = await db().insert(discoveryDocuments).values({ sourceId: source.id, title: title.slice(0, 300), content,
    fingerprint: sha1(content),
  }).onConflictDoNothing().returning({ id: discoveryDocuments.id });
  return Response.json({ received: true, duplicate: rows.length === 0 }, { status: 202 });
}
