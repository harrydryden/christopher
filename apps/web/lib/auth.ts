import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME, verifySessionCookieValue } from "./session";

/** Server actions are callable endpoints and authenticate independently of middleware. */
export async function requireSession(): Promise<void> {
  const secret = process.env.SESSION_SECRET;
  const value = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!secret || !await verifySessionCookieValue(value, secret)) throw new Error("Unauthorised");
}
