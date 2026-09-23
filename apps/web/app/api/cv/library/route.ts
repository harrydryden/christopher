import { desc, eq } from "drizzle-orm";
import { cvLibraries } from "@ava/db";
import { routeUser } from "@/lib/route-auth";
import { openStoredLibrary } from "@/lib/cv-library-rows";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The signed-in account's latest stored Library.
 *
 * The editor reads this when a save is rejected as obsolete, so it can merge the stored version
 * with the text that is still on the screen instead of asking for a reload that discards it. Read
 * only, scoped to the account by `requireUser()` — a library is never read without one — and never
 * cached, because the whole point is that the stored version has just moved.
 */
export async function GET() {
  const auth = await routeUser();
  if (!auth.ok) return auth.response;
  const user = auth.user;
  const [library] = await db()
    .select({ version: cvLibraries.version, content: cvLibraries.content })
    .from(cvLibraries)
    .where(eq(cvLibraries.userId, user.id))
    .orderBy(desc(cvLibraries.version))
    .limit(1);
  // Upgraded on the way out, as the page upgrades what it renders: the editor merges what it is
  // holding into this, and the two have to be the same shape whichever release stored it.
  return Response.json(
    { version: library?.version ?? 0, content: library?.content ? openStoredLibrary(library.content) : null },
    { headers: { "cache-control": "private, no-store" } },
  );
}
