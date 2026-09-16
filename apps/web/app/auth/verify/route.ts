import { NextResponse } from "next/server";
import { verifyEmailWithToken } from "@/lib/accounts";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** The link in the verification email. Works whether or not the person is signed in. */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const user = await verifyEmailWithToken(token);
  const current = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL(current ? "/account?verify=invalid" : "/login?error=verify_invalid", request.url));
  return NextResponse.redirect(new URL(current ? "/account?verify=done" : "/login?error=verified", request.url));
}
