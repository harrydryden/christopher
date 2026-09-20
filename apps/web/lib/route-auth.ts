import type { User } from "@christopher/db/schema";
import { requireUser } from "@/lib/auth";

export type RouteUser = { ok: true; user: User } | { ok: false; response: Response };

/**
 * Route handlers need an HTTP result where pages/actions deliberately use a thrown auth error.
 * Convert only the known missing-session result: a database or code failure must remain a 500.
 */
export async function routeUser(check: typeof requireUser = requireUser): Promise<RouteUser> {
  try {
    return { ok: true, user: await check() };
  } catch (error) {
    // Structural message check also works when Next.js/Vitest crosses a JavaScript realm.
    if (!error || typeof error !== "object" || !("message" in error) || error.message !== "Unauthorised") throw error;
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: "Please sign in again." },
        { status: 401, headers: { "cache-control": "private, no-store" } },
      ),
    };
  }
}
