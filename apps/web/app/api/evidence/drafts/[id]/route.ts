import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { evidenceDrafts } from "@col/db";
import { routeUser } from "@/lib/route-auth";
import { db } from "@/lib/db";
import { zUuid } from "@/lib/validation";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await routeUser();
  if (!auth.ok) return auth.response;
  const user = auth.user;
  const { id } = await params;
  if (!zUuid().safeParse(id).success) return NextResponse.json({ error: "Draft not found" }, { status: 404 });
  const [draft] = await db().select({ id: evidenceDrafts.id, status: evidenceDrafts.status,
    wording: evidenceDrafts.wording, error: evidenceDrafts.error, attempt: evidenceDrafts.attempt,
    acceptedVersion: evidenceDrafts.acceptedVersion, resolvedAt: evidenceDrafts.resolvedAt })
    .from(evidenceDrafts).where(and(eq(evidenceDrafts.id, id), eq(evidenceDrafts.userId, user.id))).limit(1);
  if (!draft) return NextResponse.json({ error: "Draft not found" }, { status: 404 });
  return NextResponse.json(draft, { headers: { "Cache-Control": "no-store" } });
}
