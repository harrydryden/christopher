/**
 * The Google round trip remembers where to return in a signed cookie and redirects there once the
 * sign-in succeeds. A genuine sign-in on the real domain is the most convincing place to hand a
 * person to a phishing page, so the remembered target must never leave the site.
 */
import { beforeAll, beforeEach, expect, it, vi } from "vitest";

const jar = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (options: string | { name: string }) => { jar.delete(typeof options === "string" ? options : options.name); },
  }),
}));
vi.mock("@/lib/google", async (original) => ({
  ...(await original<typeof import("@/lib/google")>()),
  exchangeGoogleCode: vi.fn(async () => ({ accessToken: "access-token" })),
  fetchGoogleProfile: vi.fn(async () => ({ sub: "google-1", email: "member@example.com", emailVerified: true })),
}));
vi.mock("@/lib/accounts", () => ({ signInWithGoogle: vi.fn(async () => ({ user: { id: "user-1" } })) }));
vi.mock("@/lib/auth", () => ({ startSession: vi.fn(async () => "session-1") }));

import { GET as start } from "../route";
import { GET as callback } from "./route";
import { OAUTH_COOKIE_NAME } from "@/lib/session";

beforeAll(() => {
  process.env.SESSION_SECRET = "google-callback-test-secret";
  process.env.GOOGLE_CLIENT_ID = "client-id";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
});
beforeEach(() => jar.clear());

/** Start at `/auth/google?next=<encoded>`, then come back from Google with the state it was given. */
async function roundTrip(encodedNext: string): Promise<string | null> {
  const started = await start(new Request(`https://app.example/auth/google?next=${encodedNext}`));
  const state = new URL(started.headers.get("location")!).searchParams.get("state");
  expect(jar.has(OAUTH_COOKIE_NAME)).toBe(true);
  const finished = await callback(new Request(`https://app.example/auth/google/callback?code=code&state=${state}`));
  return finished.headers.get("location");
}

it("returns to the page the person started from", async () => {
  expect(await roundTrip(encodeURIComponent("/companies?page=2"))).toBe("https://app.example/companies?page=2");
});

it("never redirects off-site after a genuine sign-in, whatever the next parameter carried", async () => {
  // %09 and %0A decode to a tab and a newline, which a URL parser strips: "/\t/evil.example" is "//evil.example".
  for (const next of ["%2F%09%2Fevil.example%2F", "%2F%0A%2Fevil.example", "%2F%0D%0A%2Fevil.example", "%2F.%2F%2Fevil.example", "%2F%2Fevil.example"]) {
    expect(await roundTrip(next), next).toBe("https://app.example/");
  }
});
