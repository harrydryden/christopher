/**
 * Session cookie signing/verification. Edge-safe: uses only Web Crypto (crypto.subtle),
 * available both in Next.js middleware (Edge runtime) and Node 22 (globalThis.crypto).
 *
 * Cookie value shape: `<expiresEpochSeconds>.<base64url HMAC-SHA256(expiresEpochSeconds, secret)>`
 */

const encoder = new TextEncoder();

export const SESSION_COOKIE_NAME = "christopher_session";
export const DEFAULT_SESSION_TTL_SECONDS = 2592000; // 30 days

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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

export async function createSessionCookieValue(secret: string, ttlSeconds: number = DEFAULT_SESSION_TTL_SECONDS): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = await hmac(secret, String(expires));
  return `${expires}.${signature}`;
}

export async function verifySessionCookieValue(value: string | undefined | null, secret: string): Promise<boolean> {
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const expiresPart = value.slice(0, dot);
  const signaturePart = value.slice(dot + 1);
  if (!signaturePart) return false;
  const expires = Number(expiresPart);
  if (!Number.isFinite(expires)) return false;
  if (Math.floor(Date.now() / 1000) > expires) return false;
  const expected = await hmac(secret, expiresPart);
  return constantTimeEqual(expected, signaturePart);
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
