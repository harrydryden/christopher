import { routeUser } from "@/lib/route-auth";
import { libraryImportProgress } from "@/lib/queries/library-imports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A progress read, bounded at 60 s rather than the platform default of 300. The upload itself (up to
// 5 MB) is a server action on /library, and takes that page's limit.
export const maxDuration = 60;

/**
 * How this account's Library imports in flight stand, for the Library's import poller: how many
 * are still being read, and a short fingerprint that moves when one is answered. The poller asks
 * this on each tick and refreshes the page only when it has moved, instead of re-rendering the
 * whole Library every few seconds while a document is read.
 *
 * Read only and scoped to the signed-in account: an import carries somebody's CV. Never cached,
 * because the whole point is that it has just moved.
 */
export async function GET() {
  const auth = await routeUser();
  if (!auth.ok) return auth.response;
  return Response.json(await libraryImportProgress(auth.user.id), { headers: { "cache-control": "private, no-store" } });
}
