/**
 * The company logo the worker captured, served by the interface.
 *
 * A remote icon URL is not enough: some sites hand their icon to a browser and refuse ours, so
 * what a page showed used to depend on who asked. The bytes are stored once and served from here
 * to every signed-in reader, versioned by capture time — the URL carries `?v=<ms>` and the
 * response an `etag` of the same instant, so a re-capture busts the cache and nothing else does.
 */
import { readCompanyLogo } from "@christopher/db";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { zUuid } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  if (!zUuid().safeParse(id).success) return new Response("Not found", { status: 404 });
  const logo = await readCompanyLogo(db(), id);
  if (!logo) return new Response("Not found", { status: 404 });
  const etag = `"${logo.fetchedAt.getTime()}"`;
  // Private: the catalogue is shared between accounts but not with the world, and a shared cache
  // must not hold an image a signed-out request would never have been given.
  const shared = { etag, "cache-control": "private, max-age=604800, immutable" };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: shared });
  return new Response(new Uint8Array(logo.bytes), {
    headers: { ...shared, "content-type": logo.contentType, "content-length": String(logo.bytes.length) },
  });
}
