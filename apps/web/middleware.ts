import { NextResponse, type NextRequest } from "next/server";
import { sessionCookieValue, sessionSecret, verifySessionCookieValue } from "@/lib/session";

/**
 * Everything is behind the session cookie except the sign-in pages, the Google round trip, the
 * health check, and the cron and newsletter routes, which authenticate themselves with a secret
 * rather than a browser session.
 *
 * Brand assets are public too: the browser asks for the icons and the manifest before anyone has
 * a session, and the sign-in pages render the lockup. Redirecting those to /login leaves the tab
 * with no icon and the manifest unreadable.
 *
 * `/share/` is public in a different sense: it authenticates itself by token, deriving the owner
 * from the share row so that its every read is still scoped by an account. It is matched here
 * rather than excluded so that one thing can be done to it — a `private, no-store` on the way out.
 * A shared CV is somebody's employment history sitting on a URL that has been emailed around; it
 * must not be held by a proxy, and it must not survive a revocation in a cache.
 *
 * Middleware only checks the cookie's signature and expiry (it cannot reach the database); every
 * page and action then resolves the session row, so a revoked session is refused there.
 */
export const config = {
  matcher: [
    "/((?!login|signup|forgot-password|reset-password|auth/|share/|api/health|api/cron|api/newsletters|_next|favicon\\.ico|icon\\.svg|apple-icon\\.png|manifest\\.webmanifest|brand/).*)",
    "/share/:path*",
  ],
};

export async function middleware(req: NextRequest) {
  // Never redirected to login, never cached: the token is the whole of the authentication, and
  // the page it buys is one revision of one CV.
  if (req.nextUrl.pathname.startsWith("/share/")) {
    const response = NextResponse.next();
    response.headers.set("cache-control", "private, no-store");
    return response;
  }
  const secret = sessionSecret();
  const cookie = sessionCookieValue(req.cookies);
  const authenticated = secret ? await verifySessionCookieValue(cookie, secret) : false;

  if (authenticated) return NextResponse.next();

  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "cache-control": "private, no-store" } });
  }

  const loginUrl = new URL("/login", req.url);
  const next = `${req.nextUrl.pathname}${req.nextUrl.search}`;
  if (next !== "/") loginUrl.searchParams.set("next", next);
  return NextResponse.redirect(loginUrl);
}
