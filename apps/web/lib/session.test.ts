/**
 * The cookie is the only thing middleware has to go on, so a forged, altered or expired value
 * must never read as a session. The signed-value helper carries the Google sign-in state the same way.
 */
import { describe, expect, it } from "vitest";
import {
  createSessionCookieValue, createSignedValue, isSecureHost, readSessionCookie, readSignedValue, sanitizeNextPath, sessionCookieValue,
} from "./session";

const secret = "test-secret";
const id = "0f3b2c4e-1d2a-4b6c-8e9f-0a1b2c3d4e5f";

describe("session cookie", () => {
  it("round-trips the session id and expiry", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const value = await createSessionCookieValue(secret, id, expiresAt);
    expect(value.startsWith(`v2.${id}.`)).toBe(true);
    const parsed = await readSessionCookie(value, secret);
    expect(parsed?.sessionId).toBe(id);
    expect(parsed?.expiresAt.getTime()).toBe(Math.floor(expiresAt.getTime() / 1000) * 1000);
  });

  it("rejects a forged or altered value", async () => {
    const value = await createSessionCookieValue(secret, id, new Date(Date.now() + 60_000));
    const [version, sessionId, expires, signature] = value.split(".") as [string, string, string, string];
    expect(await readSessionCookie(`${version}.${sessionId}.${Number(expires) + 100}.${signature}`, secret)).toBeNull();
    expect(await readSessionCookie(`${version}.11111111-1111-4111-8111-111111111111.${expires}.${signature}`, secret)).toBeNull();
    expect(await readSessionCookie(value, "another-secret")).toBeNull();
    // The pre-account cookie shape carried no session id and is refused outright.
    expect(await readSessionCookie(`${expires}.${signature}`, secret)).toBeNull();
    expect(await readSessionCookie("", secret)).toBeNull();
    expect(await readSessionCookie(undefined, secret)).toBeNull();
  });

  it("rejects an expired cookie even with a valid signature", async () => {
    const value = await createSessionCookieValue(secret, id, new Date(Date.now() - 1000));
    expect(await readSessionCookie(value, secret)).toBeNull();
  });
});

describe("signed values", () => {
  it("carries string fields and rejects tampering and expiry", async () => {
    const value = await createSignedValue(secret, { state: "abc", verifier: "xyz", next: "/companies" }, 60);
    expect(await readSignedValue(value, secret)).toEqual({ state: "abc", verifier: "xyz", next: "/companies" });
    expect(await readSignedValue(value, "another-secret")).toBeNull();
    const [body, expires, signature] = value.split(".") as [string, string, string];
    expect(await readSignedValue(`${body}x.${expires}.${signature}`, secret)).toBeNull();
    expect(await readSignedValue(await createSignedValue(secret, { state: "abc" }, -1), secret)).toBeNull();
  });
});

describe("redirect targets", () => {
  it("only allows same-site paths after sign-in", () => {
    expect(sanitizeNextPath("/companies?page=2")).toBe("/companies?page=2");
    expect(sanitizeNextPath("//evil.example")).toBe("/");
    expect(sanitizeNextPath("https://evil.example")).toBe("/");
    expect(sanitizeNextPath("/\\evil.example")).toBe("/");
    expect(sanitizeNextPath("")).toBe("/");
    expect(sanitizeNextPath(null)).toBe("/");
  });

  it("reads the renamed cookie first and the legacy one after it, so the rename signs nobody out", () => {
    const jar = (values: Record<string, string>) => ({ get: (name: string) => (name in values ? { value: values[name]! } : undefined) });
    expect(sessionCookieValue(jar({ ava_session: "new" }))).toBe("new");
    expect(sessionCookieValue(jar({ christopher_session: "old" }))).toBe("old");
    expect(sessionCookieValue(jar({ ava_session: "new", christopher_session: "old" }))).toBe("new");
    expect(sessionCookieValue(jar({}))).toBeUndefined();
  });

  it("marks cookies secure everywhere except plain localhost", () => {
    expect(isSecureHost("localhost:3000")).toBe(false);
    expect(isSecureHost("127.0.0.1")).toBe(false);
    expect(isSecureHost("ava.example")).toBe(true);
    expect(isSecureHost(null)).toBe(true);
  });
});
