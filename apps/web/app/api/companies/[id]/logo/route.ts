/**
 * The company logo the worker captured, served by the interface.
 *
 * A remote icon URL is not enough: some sites hand their icon to a browser and refuse ours, so
 * what a page showed used to depend on who asked. The bytes are stored once and served from here
 * to every signed-in reader, versioned by capture time — the URL carries `?v=<ms>` and the
 * response an `etag` of the same instant, so a re-capture busts the cache and nothing else does.
 */
import { unsafeSvgReason } from "@ava/core";
import { readCompanyLogo } from "@ava/db";
import { routeUser } from "@/lib/route-auth";
import { db } from "@/lib/db";
import { zUuid } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sent with every logo. The bytes come from a company's own site, and an SVG is a document that
 * would run in this origin if it were opened on its own: the policy sandboxes it (no script, a
 * unique origin) and lets it load nothing but its own inline styles and embedded images, and
 * `nosniff` stops any other type from being read as one that could do more.
 */
const LOGO_HEADERS = {
  "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
  "x-content-type-options": "nosniff",
  "content-disposition": "inline",
};

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await routeUser();
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!zUuid().safeParse(id).success) return new Response("Not found", { status: 404 });
  const logo = await readCompanyLogo(db(), id);
  if (!logo) return new Response("Not found", { status: 404 });
  // Captured before capture refused scripted SVG: never served, so the page falls back to the
  // site's own icon, and the next capture replaces it.
  if (logo.contentType === "image/svg+xml" && unsafeSvgReason(logo.bytes)) return new Response("Not found", { status: 404 });
  const version = String(logo.fetchedAt.getTime());
  const etag = `"${version}"`;
  // Public: a logo is shared catalogue data, a company's own published icon, so any cache may
  // hold it. A URL naming the capture it wants never changes meaning — a re-capture changes the
  // URL — so it is kept a day without revalidation; any other URL is kept an hour.
  const versioned = new URL(request.url).searchParams.get("v") === version;
  const shared = { ...LOGO_HEADERS, etag, "cache-control": versioned ? "public, max-age=86400, immutable" : "public, max-age=3600" };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: shared });
  return new Response(new Uint8Array(logo.bytes), {
    headers: { ...shared, "content-type": logo.contentType, "content-length": String(logo.bytes.length) },
  });
}
