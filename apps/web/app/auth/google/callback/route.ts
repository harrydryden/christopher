import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { signInWithGoogle } from "@/lib/accounts";
import { startSession } from "@/lib/auth";
import { appOrigin, exchangeGoogleCode, fetchGoogleProfile, googleConfigured } from "@/lib/google";
import { OAUTH_COOKIE_NAME, readSignedValue, sanitizeNextPath } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Finish the Google round trip: check state, exchange the code, read the profile, sign in. */
export async function GET(request: Request) {
  const secret = process.env.SESSION_SECRET;
  const fail = (error: string) => NextResponse.redirect(new URL(`/login?error=${error}`, request.url));
  if (!secret || !googleConfigured()) return fail("google_not_configured");
  const url = new URL(request.url);
  const jar = await cookies();
  const remembered = await readSignedValue(jar.get(OAUTH_COOKIE_NAME)?.value, secret);
  jar.delete({ name: OAUTH_COOKIE_NAME, path: "/auth/google" });
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!remembered || !code || !state || state !== remembered.state || !remembered.verifier) return fail("google_state");
  if (url.searchParams.get("error")) return fail("google_failed");

  try {
    const { accessToken } = await exchangeGoogleCode({ code, codeVerifier: remembered.verifier, redirectUri: `${appOrigin(request)}/auth/google/callback` });
    const profile = await fetchGoogleProfile(accessToken);
    const { user } = await signInWithGoogle(profile);
    await startSession(user.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    console.error(JSON.stringify({ event: "google_sign_in_failed", error: message.slice(0, 300) }));
    return fail(/not verified/.test(message) ? "google_unverified" : "google_failed");
  }
  return NextResponse.redirect(new URL(sanitizeNextPath(remembered.next), request.url));
}
