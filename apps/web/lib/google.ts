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
  name?: string;
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
  const response = await fetch(GOOGLE_TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  if (!response.ok) throw new Error(`Google token exchange failed (${response.status})`);
  const json = (await response.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("Google returned no access token");
  return { accessToken: json.access_token };
}

export async function fetchGoogleProfile(accessToken: string): Promise<GoogleProfile> {
  const response = await fetch(GOOGLE_USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`Google profile lookup failed (${response.status})`);
  const json = (await response.json()) as { sub?: string; email?: string; email_verified?: boolean | string; name?: string };
  if (!json.sub || !json.email) throw new Error("Google returned no account identity");
  return {
    sub: json.sub,
    email: json.email,
    emailVerified: json.email_verified === true || json.email_verified === "true",
    name: typeof json.name === "string" ? json.name : undefined,
  };
}
