/**
 * The company logo the worker captured, served by the interface.
 *
 * A remote icon URL is not enough: some sites hand their icon to a browser and refuse ours, so
 * what a page showed used to depend on who asked. The bytes are stored once and served from here
 * to every signed-in reader, versioned by capture time — the URL carries `?v=<ms>` and the
 * response an `etag` of the same instant, so a re-capture busts the cache and nothing else does.
 *
 * A URL naming the stored capture is also held by Vercel's CDN for a year (`CDN-Cache-Control`;
 * `max-age` alone is for the browser only), so after the first reader per edge region nobody pays
 * a function invocation or a database round trip for it. That is safe because a logo is shared
 * catalogue data with no account's data in it, and because the query string is part of the cache
 * key: a re-capture changes the URL. Middleware still checks the session cookie's signature before
 * the CDN answers. For a takedown, purge the CDN or move the capture time.
 */
import { unsafeSvgReason } from "@ava/core";
import { companyLogoVersion, readCompanyLogo } from "@ava/db";
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

/** Whether an `if-none-match` names this entity tag: weak or strong, alone, in a list, or `*`. */
function matches(ifNoneMatch: string, etag: string): boolean {
  return ifNoneMatch.split(",").some(part => {
    const tag = part.trim();
    return tag === "*" || tag.replace(/^W\//, "") === etag;
  });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await routeUser();
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!zUuid().safeParse(id).success) return new Response("Not found", { status: 404 });
  const requested = new URL(request.url).searchParams.get("v");
  // Public: a logo is shared catalogue data, a company's own published icon, so any cache may
  // hold it. A URL naming the capture it wants never changes meaning — a re-capture changes the
  // URL — so the browser keeps it a day without revalidation; any other URL is kept an hour.
  const browserHeaders = (version: string) => ({
    ...LOGO_HEADERS,
    etag: `"${version}"`,
    "cache-control": requested === version ? "public, max-age=86400, immutable" : "public, max-age=3600",
  });
  // A revalidation is answered from the capture time alone, before the bytes are read: a 304 has
  // no body, so reading the blob for one was a transfer thrown away. A scripted SVG, which is never
  // served (below), cannot have handed any browser this validator, so a 304 for one gives nothing.
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch) {
    const fetchedAt = await companyLogoVersion(db(), id);
    if (!fetchedAt) return new Response("Not found", { status: 404 });
    const version = String(fetchedAt.getTime());
    if (matches(ifNoneMatch, `"${version}"`)) return new Response(null, { status: 304, headers: browserHeaders(version) });
  }
  const logo = await readCompanyLogo(db(), id);
  if (!logo) return new Response("Not found", { status: 404 });
  // Captured before capture refused scripted SVG: never served, so the page falls back to the
  // site's own icon, and the next capture replaces it.
  if (logo.contentType === "image/svg+xml" && unsafeSvgReason(logo.bytes)) return new Response("Not found", { status: 404 });
  const version = String(logo.fetchedAt.getTime());
  // Only the 200 for the URL that names this capture goes to the CDN: never a 404 (a capture may
  // land a minute later), never a 304, and never an unversioned URL, whose answer changes.
  const cdn: Record<string, string> = requested === version ? { "cdn-cache-control": "public, max-age=31536000, immutable" } : {};
  return new Response(new Uint8Array(logo.bytes), {
    headers: { ...browserHeaders(version), ...cdn, "content-type": logo.contentType, "content-length": String(logo.bytes.length) },
  });
}
