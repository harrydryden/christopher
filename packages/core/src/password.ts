/**
 * Password hashing for account sign-in. Node-only (uses node:crypto scrypt).
 * Stored format: `scrypt$N$r$p$<saltBase64>$<hashBase64>`, so the parameters travel with the hash
 * and can be raised later: old hashes still verify and are rehashed on the next successful sign-in.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { renamedEnv } from "./env";

/** OWASP's recommended scrypt cost: N = 2^17, r = 8, p = 1 (128 MiB, a few hundred milliseconds). */
const DEFAULT_SCRYPT_N = 1 << 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
/** The lowest cost ever used in production; the test-only override cannot go below it. */
const MIN_SCRYPT_N = 1 << 14;

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 256;

/**
 * AVA_SCRYPT_N lets test suites hash cheaply, never below the old cost. Production ignores it: a
 * value copied from a test environment would make every new hash cheaper to crack, and
 * `needsRehash` would treat the weaker cost as current and never upgrade it.
 */
function currentN(): number {
  if (process.env.NODE_ENV === "production") return DEFAULT_SCRYPT_N;
  const raw = Number(renamedEnv(process.env, "AVA_SCRYPT_N", "CHRISTOPHER_SCRYPT_N"));
  if (Number.isInteger(raw) && raw >= MIN_SCRYPT_N && (raw & (raw - 1)) === 0) return raw;
  return DEFAULT_SCRYPT_N;
}

function scryptAsync(password: string, salt: Buffer, keylen: number, params: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const maxmem = 128 * params.N * params.r * 2;
    scryptCallback(password, salt, keylen, { N: params.N, r: params.r, p: params.p, maxmem }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

function parseStored(stored: string): { N: number; r: number; p: number; salt: Buffer; expected: Buffer } | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N < 2 || r < 1 || p < 1) return null;
  if (!saltB64 || !hashB64) return null;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  if (salt.length === 0 || expected.length === 0) return null;
  return { N, r, p, salt, expected };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const N = currentN();
  const derived = await scryptAsync(password.normalize("NFKC"), salt, KEY_LENGTH, { N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseStored(stored);
  if (!parsed) return false;
  const derived = await scryptAsync(password.normalize("NFKC"), parsed.salt, parsed.expected.length, parsed);
  if (derived.length !== parsed.expected.length) return false;
  return timingSafeEqual(derived, parsed.expected);
}

/** True when a stored hash was made with weaker parameters than we use now, so it should be replaced after a successful check. */
export function needsRehash(stored: string): boolean {
  const parsed = parseStored(stored);
  if (!parsed) return false;
  return parsed.N < currentN() || parsed.r !== SCRYPT_R || parsed.p !== SCRYPT_P;
}

/** Does this look like the `scrypt$N$r$p$salt$hash` format hashPassword produces? */
export function looksLikeScryptHash(value: string): boolean {
  const parts = value.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts;
  if (![n, r, p].every((v) => v && /^\d+$/.test(v))) return false;
  return !!salt && !!hash;
}

/** A password is acceptable when it is long enough and not absurdly long; complexity rules are not enforced. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  return null;
}
