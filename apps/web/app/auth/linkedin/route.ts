import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clientAddress, getCurrentUser } from "@/lib/auth";
import { linkedinAuthorisationUrl, linkedinConfigured } from "@/lib/linkedin";
import { LINKEDIN_COOKIE, startLinkedInTransaction } from "@/lib/linkedin-auth";
import { isSecureHost, sanitizeNextPath, sessionSecret } from "@/lib/session";
import { LIMITS, reserveRateLimits } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Start one browser-bound, database-backed OIDC round trip. */
export async function GET(request: Request) {
  const fail = (reason: string) => {
    const response = NextResponse.redirect(new URL(`/login?error=${reason}`, request.url));
    response.headers.set("cache-control", "private, no-store");
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  };
  if (!linkedinConfigured() || !sessionSecret()) return fail("linkedin_not_configured");
  if (!await reserveRateLimits([{ key: `linkedin:start:ip:${await clientAddress()}`, limit: LIMITS.loginAddress }])) return fail("rate_limited");
  const url = new URL(request.url);
  const intent = url.searchParams.get("intent") === "link" ? "link" : "sign_in";
  const current = intent === "link" ? await getCurrentUser() : null;
  if (intent === "link" && !current) return fail("linkedin_link_login");
  try {
    const started = await startLinkedInTransaction(db(), { intent, next: sanitizeNextPath(url.searchParams.get("next")),
      initiatingUserId: current?.user.id, initiatingSessionId: current?.sessionId });
    const response = NextResponse.redirect(linkedinAuthorisationUrl(started.state, started.nonce));
    response.cookies.set(LINKEDIN_COOKIE, started.cookie, { httpOnly: true, sameSite: "lax", secure: isSecureHost(new URL(process.env.APP_URL!).host), path: "/", maxAge: 60 * 60 });
    response.headers.set("cache-control", "private, no-store");
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  } catch {
    return fail("linkedin_failed");
  }
}
