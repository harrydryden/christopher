import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { appOrigin, googleAuthorizationUrl, googleConfigured, pkcePair, randomState } from "@/lib/google";
import { createSignedValue, isSecureHost, OAUTH_COOKIE_NAME, sanitizeNextPath, sessionSecret } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Start the Google round trip: remember state, the PKCE verifier and where to return, then redirect. */
export async function GET(request: Request) {
  const secret = sessionSecret();
  if (!secret || !googleConfigured()) return NextResponse.redirect(new URL("/login?error=google_not_configured", request.url));
  const origin = appOrigin(request);
  const next = sanitizeNextPath(new URL(request.url).searchParams.get("next"));
  const state = randomState();
  const { verifier, challenge } = pkcePair();
  const value = await createSignedValue(secret, { state, verifier, next }, 10 * 60);
  (await cookies()).set(OAUTH_COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: "lax",
    path: "/auth/google",
    secure: isSecureHost(request.headers.get("host")),
    maxAge: 10 * 60,
  });
  return NextResponse.redirect(googleAuthorizationUrl({ redirectUri: `${origin}/auth/google/callback`, state, codeChallenge: challenge }));
}
