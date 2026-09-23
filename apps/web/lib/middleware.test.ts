/**
 * Middleware turns away a request with no valid session cookie before any page or route runs. Its
 * refusal for an API path must not be cached any more than the answers the routes give themselves.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { createSessionCookieValue, SESSION_COOKIE_NAME } from "./session";

beforeEach(() => vi.stubEnv("SESSION_SECRET", "middleware-test-secret"));
afterEach(() => vi.unstubAllEnvs());

it("refuses an API call without a session, uncached", async () => {
  const response = await middleware(new NextRequest("https://ava.test/api/work-status"));
  expect(response.status).toBe(401);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});

it("sends a page visit without a session to sign-in, remembering where it was going", async () => {
  const response = await middleware(new NextRequest("https://ava.test/companies?page=2"));
  expect(response.headers.get("location")).toBe("https://ava.test/login?next=%2Fcompanies%3Fpage%3D2");
});

it("lets a signed cookie through", async () => {
  const cookie = await createSessionCookieValue("middleware-test-secret", "0f3b2c4e-1d2a-4b6c-8e9f-0a1b2c3d4e5f", new Date(Date.now() + 60_000));
  const response = await middleware(new NextRequest("https://ava.test/api/work-status", { headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } }));
  expect(response.status).toBe(200);
  expect(response.headers.get("x-middleware-next")).toBe("1");
});
