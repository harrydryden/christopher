import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { getCurrentUser, startSession } from "@/lib/auth";
import { exchangeLinkedInCode, linkedinConfigured, verifyLinkedInIdToken } from "@/lib/linkedin";
import { claimLinkedInCallback, LINKEDIN_COOKIE, settleLinkedInIdentity } from "@/lib/linkedin-auth";

export const dynamic = "force-dynamic";

/** A one-use state claim precedes token exchange, so a replay cannot send a second provider call. */
export async function GET(request: Request) {
  const secureRedirect = (destination: string) => {
    const response = NextResponse.redirect(new URL(destination, request.url));
    response.headers.set("cache-control", "private, no-store");
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  };
  const fail = (reason: string) => secureRedirect(`/login?error=${reason}`);
  if (!linkedinConfigured()) return fail("linkedin_not_configured");
  const url = new URL(request.url);
  const jar = await cookies();
  const cookie = jar.get(LINKEDIN_COOKIE)?.value;
  const claimed = await claimLinkedInCallback(db(), { cookie, state: url.searchParams.get("state") ?? undefined }).catch(() => null);
  if (!claimed) return fail("linkedin_state");
  if (url.searchParams.has("error")) return fail("linkedin_cancelled");
  const code = url.searchParams.get("code");
  if (!code) return fail("linkedin_failed");
  try {
    // An explicit link must return in the same account; a stolen signed-in session is not enough to complete it.
    if (claimed.intent === "link") {
      const current = await getCurrentUser();
      if (!current || current.user.id !== claimed.initiatingUserId || current.sessionId !== claimed.initiatingSessionId) return fail("linkedin_state");
    }
    const identity = await verifyLinkedInIdToken(await exchangeLinkedInCode(code), claimed.nonceHash);
    const settled = await settleLinkedInIdentity(db(), cookie, identity);
    if (settled.kind === "signed_in") {
      await startSession(settled.user.id, undefined, "linkedin");
      jar.delete(LINKEDIN_COOKIE);
      return secureRedirect(settled.next);
    }
    return secureRedirect("/auth/linkedin/continue");
  } catch {
    // No provider message or token is exposed to the member or logs.
    return fail("linkedin_failed");
  }
}
