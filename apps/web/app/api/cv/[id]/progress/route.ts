import { routeUser } from "@/lib/route-auth";
import { zUuid } from "@/lib/validation";
import { readCvProgress } from "@/lib/queries/cv";
import { cvProgressReading } from "@/lib/cv-progress";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "private, no-store" };

/** The newest moment in a `cvStepsSignature` ("count:running:ISO"), or null when it has none. */
function signatureMoment(sig: string | null): Date | null {
  if (!sig) return null;
  const counts = sig.indexOf(":", sig.indexOf(":") + 1);
  if (counts === -1) return null;
  const moment = new Date(sig.slice(counts + 1));
  return Number.isNaN(moment.getTime()) ? null : moment;
}

/** A timezone the formatter accepts, or UTC: it only sets the clock a retry is due at. */
function timeZoneOf(value: string | null): string {
  if (!value) return "UTC";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
    return value;
  } catch {
    return "UTC";
  }
}

/**
 * `GET /api/cv/[id]/progress?after=<seq>&sig=<signature>&tz=<zone>` — what changed in one build
 * since the reader's last look.
 *
 * The CV page polls this instead of re-rendering itself: it answers the draft's state, the version
 * token the page compares to decide whether a server render is needed at all (a status change, a
 * failure, the build going stale or stopping), and only the ledger rows the reader does not have —
 * after its last `seq`, still open, or closed after the newest moment in its signature. The page
 * merges them and renders the narrative itself.
 *
 * Its cost per poll is the session lookup and one query.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await routeUser();
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!zUuid().safeParse(id).success) return Response.json({ ok: false, error: "Invalid ID" }, { status: 400, headers: NO_STORE });
  const search = new URL(request.url).searchParams;
  const afterRaw = Number(search.get("after") ?? 0);
  const after = Number.isFinite(afterRaw) && afterRaw > 0 ? Math.floor(afterRaw) : 0;
  const rows = await readCvProgress(auth.user.id, id, { after, last: after > 0 ? signatureMoment(search.get("sig")) : null });
  if (!rows) return Response.json({ ok: false, error: "Not found" }, { status: 404, headers: NO_STORE });
  return Response.json(cvProgressReading(rows, new Date(), timeZoneOf(search.get("tz"))), { headers: NO_STORE });
}
