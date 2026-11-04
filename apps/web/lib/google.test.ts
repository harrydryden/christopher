import { afterEach, expect, it, vi } from "vitest";
import { exchangeGoogleCode, fetchGoogleProfile, googleAuthoritativeEmail, GOOGLE_TOKEN_URL, GOOGLE_USERINFO_URL } from "./google";

afterEach(() => vi.unstubAllGlobals());

it("bounds the token response and refuses redirects without disclosing the secret", async () => {
  vi.stubEnv("GOOGLE_CLIENT_ID", "test-client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-secret");
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.cache).toBe("no-store");
    return new Response("x".repeat(65_537));
  });
  vi.stubGlobal("fetch", fetcher);
  await expect(exchangeGoogleCode({ code: "code", codeVerifier: "verifier", redirectUri: "https://app.example/callback" }))
    .rejects.toThrow(/too large/);
  expect(fetcher).toHaveBeenCalledWith(GOOGLE_TOKEN_URL, expect.anything());
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("rejects an oversized profile while preserving the pinned endpoint", async () => {
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    return new Response("{}", { headers: { "content-length": "65537" } });
  });
  vi.stubGlobal("fetch", fetcher);
  await expect(fetchGoogleProfile("access-token")).rejects.toThrow(/too large/);
  expect(fetcher).toHaveBeenCalledWith(GOOGLE_USERINFO_URL, expect.anything());
});

it("accepts a small verified profile and rejects a redirected token response", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ sub: "stable-sub", email: "person@example.com", email_verified: true }))));
  expect(await fetchGoogleProfile("access-token")).toMatchObject({ sub: "stable-sub", emailVerified: true });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example" } })));
  await expect(exchangeGoogleCode({ code: "code", codeVerifier: "verifier", redirectUri: "https://app.example/callback" }))
    .rejects.toThrow(/could not complete/);
});

it("treats only Google-hosted, verified addresses as authoritative", () => {
  expect(googleAuthoritativeEmail({ sub: "one", email: "person@gmail.com", emailVerified: true })).toBe(true);
  expect(googleAuthoritativeEmail({ sub: "two", email: "person@example.com", emailVerified: true, hostedDomain: "example.com" })).toBe(true);
  expect(googleAuthoritativeEmail({ sub: "three", email: "person@example.com", emailVerified: true })).toBe(false);
  expect(googleAuthoritativeEmail({ sub: "four", email: "person@gmail.com", emailVerified: false })).toBe(false);
  expect(googleAuthoritativeEmail({ sub: "five", email: "person@example.com", emailVerified: true, hostedDomain: "bad domain" })).toBe(false);
});

it("reads only a valid hosted-domain claim from userinfo", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ sub: "stable-sub", email: "person@example.com",
    email_verified: true, hd: "Example.COM" }))));
  expect(await fetchGoogleProfile("access-token")).toMatchObject({ hostedDomain: "example.com" });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ sub: "stable-sub", email: "person@example.com",
    email_verified: true, hd: "bad domain" }))));
  await expect(fetchGoogleProfile("access-token")).rejects.toThrow(/usable account identity/);
});
