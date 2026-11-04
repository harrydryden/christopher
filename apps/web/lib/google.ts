/**
 * Google sign-in: OAuth 2.0 authorization code flow with PKCE, implemented with fetch only.
 * The profile is read from Google's userinfo endpoint using the access token returned to us
 * directly over TLS, so no JWT verification is needed.
 */
import { createHash, randomBytes } from "node:crypto";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export function googleConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/** The public origin of this deployment, from APP_URL or the proxied request headers. */
export function appOrigin(request: Request): string {
  const configured = process.env.APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host") || url.host;
  return `${proto}://${host}`;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function randomState(): string {
  return randomBytes(24).toString("base64url");
}

export function googleAuthorizationUrl(input: { redirectUri: string; state: string; codeChallenge: string; loginHint?: string }): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID ?? "");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
  return url.toString();
}

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  hostedDomain?: string;
  name?: string;
}

const HOSTED_DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** Google can prove an address remains owned only when it hosts that mailbox or Workspace domain. */
export function googleAuthoritativeEmail(profile: GoogleProfile): boolean {
  if (profile.emailVerified !== true) return false;
  return profile.email.trim().toLowerCase().endsWith("@gmail.com") ||
    (!!profile.hostedDomain && HOSTED_DOMAIN_RE.test(profile.hostedDomain));
}

const GOOGLE_RESPONSE_LIMIT = 65_536;

async function googleJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error("Google sign-in could not complete");
  const advertised = Number(response.headers.get("content-length") ?? "0");
  if (advertised > GOOGLE_RESPONSE_LIMIT) throw new Error("Google sign-in answer was too large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Google sign-in answer was empty");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > GOOGLE_RESPONSE_LIMIT) {
      await reader.cancel();
      throw new Error("Google sign-in answer was too large");
    }
    chunks.push(part.value);
  }
  try {
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(joined));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad shape");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("Google sign-in answer was invalid");
  }
}

export async function exchangeGoogleCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<{ accessToken: string }> {
  const body = new URLSearchParams({
    code: input.code,
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
    code_verifier: input.codeVerifier,
  });
  const response = await fetch(GOOGLE_TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
    signal: AbortSignal.timeout(8_000), cache: "no-store", redirect: "error" });
  const json = await googleJson(response);
  if (typeof json.access_token !== "string" || !json.access_token || json.access_token.length > 16_384) throw new Error("Google returned no usable access token");
  return { accessToken: json.access_token };
}

export async function fetchGoogleProfile(accessToken: string): Promise<GoogleProfile> {
  const response = await fetch(GOOGLE_USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(8_000), cache: "no-store", redirect: "error" });
  const json = await googleJson(response);
  if (typeof json.sub !== "string" || typeof json.email !== "string" || !json.sub.trim() || json.sub.length > 300 ||
    !json.email.trim() || json.email.length > 254 || (typeof json.name === "string" && json.name.length > 200) ||
    (json.hd !== undefined && (typeof json.hd !== "string" || !HOSTED_DOMAIN_RE.test(json.hd)))) {
    throw new Error("Google returned no usable account identity");
  }
  return {
    sub: json.sub,
    email: json.email,
    emailVerified: json.email_verified === true || json.email_verified === "true",
    hostedDomain: typeof json.hd === "string" ? json.hd.toLowerCase() : undefined,
    name: typeof json.name === "string" ? json.name : undefined,
  };
}
