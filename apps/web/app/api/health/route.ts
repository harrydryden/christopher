import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  // Vercel supplies this for every deployment. Keep the public response deliberately small: it
  // proves which immutable source revision is serving without disclosing configuration, database
  // state or provider identifiers.
  const commit = process.env.VERCEL_GIT_COMMIT_SHA ?? null;
  return NextResponse.json({ ok: true, commit }, {
    headers: { "cache-control": "no-store" },
  });
}
