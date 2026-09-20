import { routeUser } from "@/lib/route-auth";
import { libraryReviewSignature, ownsLibraryVersion } from "@/lib/queries/cv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A short fingerprint of one saved version's evidence reviews, for the Library's poller.
 *
 * It moves when a review is added, replaced, rescored or reclassified, and not otherwise, so the
 * page refreshes when the baseline lands and again when the model's own review does, and sits
 * still in between. Read only, scoped to the account by `requireUser()`, and the version must be
 * one this account saved — a review is per account and is never read without one. Never cached:
 * the whole point is that it has just moved.
 */
export async function GET(request: Request) {
  const auth = await routeUser();
  if (!auth.ok) return auth.response;
  const user = auth.user;
  const version = Number(new URL(request.url).searchParams.get("version"));
  if (!Number.isInteger(version) || version < 1) {
    return Response.json({ ok: false, error: "Ask for a saved library version." }, { status: 400 });
  }
  if (!(await ownsLibraryVersion(user.id, version))) {
    return Response.json({ ok: false, error: "No such library version." }, { status: 404 });
  }
  return Response.json(
    { signature: await libraryReviewSignature(user.id, version) },
    { headers: { "cache-control": "private, no-store" } },
  );
}
