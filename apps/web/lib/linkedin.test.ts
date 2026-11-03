import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { exchangeLinkedInCode, linkedinAuthorisationUrl, linkedinConfigured, linkedinRedirectUri, sha256, verifyLinkedInIdToken } from "./linkedin";

let privateKey: CryptoKey;
let verifier: Parameters<typeof verifyLinkedInIdToken>[2];
const issuer = "https://www.linkedin.com/oauth";
const nonce = "browser-specific-nonce";

beforeAll(async () => {
  const keys = await generateKeyPair("RS256");
  privateKey = keys.privateKey;
  const jwk = await exportJWK(keys.publicKey);
  verifier = createLocalJWKSet({ keys: [{ ...jwk, kid: "fixture-key", alg: "RS256", use: "sig" }] }) as Parameters<typeof verifyLinkedInIdToken>[2];
});
beforeEach(() => {
  vi.stubEnv("LINKEDIN_CLIENT_ID", "course-of-life-test");
  vi.stubEnv("LINKEDIN_CLIENT_SECRET", "server-secret");
  vi.stubEnv("APP_URL", "https://course.example");
});
afterEach(() => vi.unstubAllEnvs());

async function signed(overrides: JWTPayload = {}, omit: string[] = []) {
  const now = Math.floor(Date.now() / 1000);
  const claims: JWTPayload = {
    iss: issuer, aud: "course-of-life-test", sub: "member-subject", iat: now, exp: now + 300,
    nonce, email: "member@example.com", email_verified: true, name: "Example Member", ...overrides,
  };
  for (const key of omit) delete claims[key];
  return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "fixture-key" }).sign(privateKey);
}

describe("LinkedIn identity verification", () => {
  it("accepts a correctly signed, intended identity without treating email as its identifier", async () => {
    expect(await verifyLinkedInIdToken(await signed(), sha256(nonce), verifier)).toEqual({
      issuer, sub: "member-subject", email: "member@example.com", emailVerified: true, name: "Example Member",
    });
  });
  it("accepts absent optional email fields and does not invent verification", async () => {
    expect(await verifyLinkedInIdToken(await signed({}, ["email", "email_verified", "name"]), sha256(nonce), verifier))
      .toEqual({ issuer, sub: "member-subject", email: null, emailVerified: false, name: null });
    expect((await verifyLinkedInIdToken(await signed({ email_verified: "true" }), sha256(nonce), verifier)).emailVerified).toBe(false);
  });
  it.each([
    ["another issuer", { iss: "https://attacker.example" }],
    ["another client", { aud: "another-client" }],
    ["another nonce", { nonce: "different-browser" }],
    ["expired token", { exp: Math.floor(Date.now() / 1000) - 120 }],
    ["stale token", { iat: Math.floor(Date.now() / 1000) - 900 }],
    ["future issue time", { iat: Math.floor(Date.now() / 1000) + 120 }],
    ["blank subject", { sub: " " }],
    ["wrong authorised party", { azp: "another-client" }],
    ["multiple audiences without authorised party", { aud: ["course-of-life-test", "another-client"] }],
  ] as const)("rejects %s even with a valid signature", async (_label, claims) => {
    await expect(verifyLinkedInIdToken(await signed(claims as JWTPayload), sha256(nonce), verifier)).rejects.toThrow();
  });
  it.each(["sub", "exp", "iat", "nonce"])("requires %s rather than accepting a signed but incomplete identity", async claim => {
    await expect(verifyLinkedInIdToken(await signed({}, [claim]), sha256(nonce), verifier)).rejects.toThrow();
  });
  it("rejects an attacker signing a token with their own key", async () => {
    const attacker = await generateKeyPair("RS256");
    const token = await new SignJWT({ iss: issuer, aud: "course-of-life-test", sub: "victim", nonce })
      .setIssuedAt().setExpirationTime("5m").setProtectedHeader({ alg: "RS256", kid: "fixture-key" }).sign(attacker.privateKey);
    await expect(verifyLinkedInIdToken(token, sha256(nonce), verifier)).rejects.toThrow();
  });
  it("refuses a symmetric token even when it has the expected claims", async () => {
    const token = await new SignJWT({ iss: issuer, aud: "course-of-life-test", sub: "victim", nonce })
      .setIssuedAt().setExpirationTime("5m").setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode("attacker-secret"));
    await expect(verifyLinkedInIdToken(token, sha256(nonce), verifier)).rejects.toThrow();
  });
});

describe("LinkedIn OAuth request boundaries", () => {
  it("requests only sign-in scopes and uses the configured callback origin", () => {
    const url = new URL(linkedinAuthorisationUrl("random-state", nonce));
    expect(url.origin + url.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(url.searchParams.get("scope")).toBe("openid profile email");
    expect(url.searchParams.get("redirect_uri")).toBe("https://course.example/auth/linkedin/callback");
    expect(url.searchParams.get("state")).toBe("random-state");
    expect(url.searchParams.get("nonce")).toBe(nonce);
    expect(url.searchParams.has("client_secret")).toBe(false);
  });
  it("does not enable the provider with incomplete configuration", () => {
    expect(linkedinConfigured()).toBe(true);
    vi.stubEnv("LINKEDIN_CLIENT_SECRET", "");
    expect(linkedinConfigured()).toBe(false);
  });
  it("rejects an insecure remote callback", () => {
    vi.stubEnv("APP_URL", "http://course.example");
    expect(() => linkedinRedirectUri()).toThrow();
  });
  it("exchanges on the pinned server endpoint and retains only the ID token", async () => {
    const fetcher = vi.fn(async () => Response.json({ id_token: "signed-identity", access_token: "discard-me" }));
    expect(await exchangeLinkedInCode("code", fetcher as typeof fetch)).toBe("signed-identity");
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://www.linkedin.com/oauth/v2/accessToken");
    expect(options.method).toBe("POST");
    expect(options.cache).toBe("no-store");
    expect(options.body).toBeInstanceOf(URLSearchParams);
    expect((options.body as URLSearchParams).get("redirect_uri")).toBe("https://course.example/auth/linkedin/callback");
  });
  it.each([
    ["rejected request", () => new Response("provider secret details", { status: 400 })],
    ["missing ID token", () => Response.json({ access_token: "not-an-identity" })],
    ["oversized ID token", () => Response.json({ id_token: "x".repeat(16_385) })],
  ] as const)("fails closed on %s without exposing provider body", async (_label, response) => {
    await expect(exchangeLinkedInCode("code", vi.fn(async () => response()) as typeof fetch)).rejects.toThrow();
  });
});
