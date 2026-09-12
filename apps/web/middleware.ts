import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionCookieValue } from "@/lib/session";

/**
 * Everything is behind the session cookie except the login page, the health check, and the cron
 * route, which authenticates itself with CRON_SECRET rather than a browser session.
 *
 * Brand assets are public too: the browser asks for the icons and the manifest before anyone has
 * a session, and the login page itself renders the lockup. Redirecting those to /login leaves the
 * tab with no icon and the manifest unreadable.
 */
export const config = {
  matcher: [
    "/((?!login|api/health|api/cron|api/newsletters|_next|favicon\\.ico|icon\\.svg|apple-icon\\.png|manifest\\.webmanifest|brand/).*)",
  ],
};

export async function middleware(req: NextRequest) {
  const secret = process.env.SESSION_SECRET;
  const cookie = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const authenticated = secret ? await verifySessionCookieValue(cookie, secret) : false;

  if (authenticated) return NextResponse.next();

  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const loginUrl = new URL("/login", req.url);
  const next = `${req.nextUrl.pathname}${req.nextUrl.search}`;
  if (next !== "/") loginUrl.searchParams.set("next", next);
  return NextResponse.redirect(loginUrl);
}
