/** LinkedIn OIDC is authentication only; it never grants profile or connections import. */
import { createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

const ISSUER = "https://www.linkedin.com/oauth";
const AUTHORISE = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN = "https://www.linkedin.com/oauth/v2/accessToken";
const JWKS = "https://www.linkedin.com/oauth/openid/jwks";
const keys = createRemoteJWKSet(new URL(JWKS), { timeoutDuration: 8_000, cooldownDuration: 30_000 });

export function linkedinConfigured(): boolean {
  return !!(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET && process.env.APP_URL);
}

export function linkedinRedirectUri(): string {
  const raw = process.env.APP_URL;
  if (!raw) throw new Error("LinkedIn sign-in is not configured");
  const origin = new URL(raw);
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && (origin.hostname === "localhost" || origin.hostname === "127.0.0.1"))) throw new Error("LinkedIn callback requires HTTPS");
  return `${origin.origin}/auth/linkedin/callback`;
}

export function linkedinAuthorisationUrl(state: string, nonce: string): string {
  const url = new URL(AUTHORISE);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", process.env.LINKEDIN_CLIENT_ID ?? "");
  url.searchParams.set("redirect_uri", linkedinRedirectUri());
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  return url.toString();
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function equalHash(a: string, b: string): boolean {
  const aa = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return aa.length === 32 && bb.length === 32 && timingSafeEqual(aa, bb);
}

export interface LinkedInIdentity {
  issuer: typeof ISSUER;
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

/** Exchange only against the pinned endpoint, with a bounded response and no retained access token. */
export async function exchangeLinkedInCode(code: string, fetcher: typeof fetch = fetch): Promise<string> {
  if (!linkedinConfigured() || !code || code.length > 2048) throw new Error("LinkedIn sign-in could not complete");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: process.env.LINKEDIN_CLIENT_ID!,
    client_secret: process.env.LINKEDIN_CLIENT_SECRET!,
    redirect_uri: linkedinRedirectUri(),
  });
  const response = await fetcher(TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(8_000), cache: "no-store", redirect: "error" });
  if (!response.ok) throw new Error("LinkedIn token exchange failed");
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > 65_536) throw new Error("LinkedIn token answer was too large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("LinkedIn token answer was empty");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > 65_536) {
      await reader.cancel();
      throw new Error("LinkedIn token answer was too large");
    }
    chunks.push(part.value);
  }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  const raw = new TextDecoder().decode(all);
  const data = JSON.parse(raw) as { id_token?: unknown };
  if (typeof data.id_token !== "string" || data.id_token.length > 16_384) throw new Error("LinkedIn returned no usable identity token");
  return data.id_token;
}

export async function verifyLinkedInIdToken(idToken: string, nonceHash: string, verifier: typeof keys = keys): Promise<LinkedInIdentity> {
  if (idToken.length > 16_384 || !nonceHash) throw new Error("LinkedIn identity token is invalid");
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  if (!clientId) throw new Error("LinkedIn sign-in is not configured");
  const { payload, protectedHeader } = await jwtVerify(idToken, verifier, {
    algorithms: ["RS256"], issuer: ISSUER, audience: clientId,
    maxTokenAge: "10m", clockTolerance: "60s",
    requiredClaims: ["sub", "exp", "iat", "nonce"],
  });
  if (protectedHeader.alg !== "RS256") throw new Error("LinkedIn identity token algorithm is invalid");
  const p = payload as JWTPayload & { nonce?: unknown; email?: unknown; email_verified?: unknown; name?: unknown; azp?: unknown };
  if (typeof p.sub !== "string" || !p.sub.trim() || p.sub.length > 300 || typeof p.nonce !== "string" || !equalHash(sha256(p.nonce), nonceHash)) throw new Error("LinkedIn identity token claims are invalid");
  if ((Array.isArray(p.aud) && p.aud.length > 1) || p.azp !== undefined) {
    if (p.azp !== clientId) throw new Error("LinkedIn identity token party is invalid");
  }
  return {
    issuer: ISSUER,
    sub: p.sub,
    email: typeof p.email === "string" && p.email.length <= 254 ? p.email : null,
    emailVerified: p.email_verified === true,
    name: typeof p.name === "string" ? p.name.slice(0, 200) : null,
  };
}
