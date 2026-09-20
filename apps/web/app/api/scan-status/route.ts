import { routeUser } from "@/lib/route-auth";
import { getScanStatus } from "@/lib/scan-status";
export const dynamic = "force-dynamic";
export async function GET() {
  const auth = await routeUser();
  if (!auth.ok) return auth.response;
  const user = auth.user;
  return Response.json(await getScanStatus(user.id), { headers: { "cache-control": "no-store" } });
}
