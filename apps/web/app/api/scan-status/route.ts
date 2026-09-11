import { requireSession } from "@/lib/auth";
import { getScanStatus } from "@/lib/scan-status";
export const dynamic = "force-dynamic";
export async function GET() {
  await requireSession();
  return Response.json(await getScanStatus(), { headers: { "cache-control": "no-store" } });
}
