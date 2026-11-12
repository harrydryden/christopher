import { acknowledgeCvActivity, getCvActivities } from "@col/db";
import { db } from "@/lib/db";
import { routeUser } from "@/lib/route-auth";
import { sameOrigin, readCapped } from "@/lib/route-request";
import { zUuid } from "@/lib/validation";
import { serialiseCvActivities } from "@/lib/cv-activity-reading";
export const dynamic = "force-dynamic";
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "private, no-store" } });
export async function GET() {
  const auth = await routeUser();
  if (!auth.ok) return auth.response;
  return json(serialiseCvActivities(await getCvActivities(db(), auth.user.id)));
}
export async function POST(request: Request) {
  const auth = await routeUser();
  if (!auth.ok) return auth.response;
  if (!sameOrigin(request)) return json({ ok: false }, 403);
  if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ ok: false }, 415);
  const body = await readCapped(request, 256);
  if (!body.ok) return json({ ok: false }, 400);
  let id: string;
  try { id = zUuid().parse(JSON.parse(new TextDecoder().decode(body.bytes)).id); }
  catch { return json({ ok: false }, 400); }
  const ok = await acknowledgeCvActivity(db(), auth.user.id, id);
  return json({ ok }, ok ? 200 : 404);
}
