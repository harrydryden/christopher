import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { GoogleEmailProofError, signInWithGoogle } from "@/lib/accounts";
import { clientAddress, getCurrentUser, startSessionFromProof } from "@/lib/auth";
import { appOrigin, exchangeGoogleCode, fetchGoogleProfile, googleConfigured } from "@/lib/google";
import { LIMITS, releaseRateLimitReservations, reserveRateLimits } from "@/lib/rate-limit";
import { LEGACY_OAUTH_COOKIE_NAMES, OAUTH_COOKIE_NAME, oauthCookieValue, readSignedValue, sanitizeNextPath, sessionSecret } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Finish the Google round trip: check state, exchange the code, read the profile, sign in. */
export async function GET(request: Request) {
  const secret = sessionSecret();
  const fail = (error: string) => NextResponse.redirect(new URL(`/login?error=${error}`, request.url));
  if (!secret || !googleConfigured()) return fail("google_not_configured");
  const url = new URL(request.url);
  const jar = await cookies();
  const remembered = await readSignedValue(oauthCookieValue(jar), secret);
  for (const name of [OAUTH_COOKIE_NAME, ...LEGACY_OAUTH_COOKIE_NAMES]) jar.delete({ name, path: "/auth/google" });
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!remembered || !code || !state || state !== remembered.state || !remembered.verifier) return fail("google_state");
  if (url.searchParams.get("error")) return fail("google_failed");
  const address = await clientAddress();
  const reservation = await reserveRateLimits([{ key: `login:ip:${address}`, limit: LIMITS.loginAddress }]);
  if (!reservation) return fail("rate_limited");

  try {
    const { accessToken } = await exchangeGoogleCode({ code, codeVerifier: remembered.verifier, redirectUri: `${appOrigin(request)}/auth/google/callback` });
    const profile = await fetchGoogleProfile(accessToken);
    const current = await getCurrentUser();
    const { user } = await signInWithGoogle(profile, current ? { userId: current.user.id, sessionId: current.sessionId } : undefined);
    if (!(await startSessionFromProof({ userId: user.id, proof: { provider: "google", subject: profile.sub } }))) {
      throw new Error("Google identity changed during sign-in");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    console.error(JSON.stringify({ event: "google_sign_in_failed", error: message.slice(0, 300) }));
    return fail(error instanceof GoogleEmailProofError ? "google_email_proof" : /not verified/.test(message) ? "google_unverified" : /Registration is closed/.test(message) ? "closed" : "google_failed");
  }
  await releaseRateLimitReservations(reservation).catch(() => undefined);
  return NextResponse.redirect(new URL(sanitizeNextPath(remembered.next), request.url));
}
