import { requireUser } from "@/lib/auth";
import { getScanStatus } from "@/lib/scan-status";
export const dynamic = "force-dynamic";
export async function GET() {
  const user = await requireUser();
  return Response.json(await getScanStatus(user.id), { headers: { "cache-control": "no-store" } });
}
