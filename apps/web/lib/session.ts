/**
 * Session cookie signing/verification. Edge-safe: uses only Web Crypto (crypto.subtle),
 * available both in Next.js middleware (Edge runtime) and Node 22 (globalThis.crypto).
 *
 * Cookie value shape: `v2.<sessionId>.<expiresEpochSeconds>.<base64url HMAC-SHA256(sessionId.expires, secret)>`
 *
 * The signature lets middleware turn away anonymous requests without a database round trip;
 * the session id is then checked against the `sessions` table by `getCurrentUser`, which is what
 * makes sign-out and "sign out everywhere" take effect immediately.
 */

const encoder = new TextEncoder();

export const SESSION_COOKIE_NAME = "ava_session";
/**
 * The session cookie's name before the product was renamed. It is still read, after
 * `SESSION_COOKIE_NAME`, so nobody is signed out by the deploy, and `endSession` clears it too.
 * Remove it one session TTL (30 days) after the release, when the last one has expired.
 */
export const LEGACY_SESSION_COOKIE_NAME = "christopher_session";
/** Short-lived state for the Google sign-in round trip. */
export const OAUTH_COOKIE_NAME = "ava_oauth";
export const DEFAULT_SESSION_TTL_SECONDS = 2592000; // 30 days

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return atob(base64);
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return toBase64Url(new Uint8Array(signature));
}

/** Constant-time string comparison (equal-length fast path; Web Crypto has no timingSafeEqual). */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The session cookie a request carries: the current name first, then the legacy one. */
export function sessionCookieValue(jar: { get(name: string): { value: string } | undefined }): string | undefined {
  return jar.get(SESSION_COOKIE_NAME)?.value ?? jar.get(LEGACY_SESSION_COOKIE_NAME)?.value;
}

export interface SessionCookie {
  sessionId: string;
  expiresAt: Date;
}

export async function createSessionCookieValue(secret: string, sessionId: string, expiresAt: Date): Promise<string> {
  const expires = Math.floor(expiresAt.getTime() / 1000);
  const signature = await hmac(secret, `${sessionId}.${expires}`);
  return `v2.${sessionId}.${expires}.${signature}`;
}

/** The session id and expiry a cookie names, or null when it is missing, malformed, expired or forged. */
export async function readSessionCookie(value: string | undefined | null, secret: string): Promise<SessionCookie | null> {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v2") return null;
  const [, sessionId, expiresPart, signaturePart] = parts as [string, string, string, string];
  if (!UUID_RE.test(sessionId) || !signaturePart) return null;
  const expires = Number(expiresPart);
  if (!Number.isFinite(expires)) return null;
  if (Math.floor(Date.now() / 1000) > expires) return null;
  const expected = await hmac(secret, `${sessionId}.${expiresPart}`);
  if (!constantTimeEqual(expected, signaturePart)) return null;
  return { sessionId: sessionId.toLowerCase(), expiresAt: new Date(expires * 1000) };
}

export async function verifySessionCookieValue(value: string | undefined | null, secret: string): Promise<boolean> {
  return (await readSessionCookie(value, secret)) !== null;
}

/** A signed, expiring bag of strings for short round trips such as the OAuth state. */
export async function createSignedValue(secret: string, payload: Record<string, string>, ttlSeconds: number): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = await hmac(secret, `${body}.${expires}`);
  return `${body}.${expires}.${signature}`;
}

export async function readSignedValue(value: string | undefined | null, secret: string): Promise<Record<string, string> | null> {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [body, expiresPart, signaturePart] = parts as [string, string, string];
  const expires = Number(expiresPart);
  if (!Number.isFinite(expires) || Math.floor(Date.now() / 1000) > expires) return null;
  const expected = await hmac(secret, `${body}.${expiresPart}`);
  if (!constantTimeEqual(expected, signaturePart)) return null;
  try {
    const parsed = JSON.parse(fromBase64Url(body)) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const out: Record<string, string> = {};
    for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) if (typeof val === "string") out[key] = val;
    return out;
  } catch {
    return null;
  }
}

/** Whether the cookie should be marked Secure. Skip only for plain localhost development. */
export function isSecureHost(host: string | null | undefined): boolean {
  if (!host) return true;
  const hostname = host.split(":")[0] ?? host;
  return hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1";
}

/** Only allow same-site relative redirects after login (never "//host" or "scheme://host"). */
export function sanitizeNextPath(next: string | null | undefined): string {
  if (!next) return "/";
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("://") || next.includes("\\")) return "/";
  return next;
}
