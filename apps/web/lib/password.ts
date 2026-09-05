/**
 * Password hashing for the single application password. Node-only (uses node:crypto scrypt).
 * Stored format: `scrypt$N$r$p$<saltBase64>$<hashBase64>`.
 */
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const MAX_MEM = 128 * SCRYPT_N * SCRYPT_R * 2;

function scryptAsync(password: string, salt: Buffer, keylen: number, params: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const maxmem = Math.max(MAX_MEM, 128 * params.N * params.r * 2);
    scryptCallback(password, salt, keylen, { N: params.N, r: params.r, p: params.p, maxmem }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password.normalize("NFKC"), salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  if (!saltB64 || !hashB64) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltB64, "base64");
    expected = Buffer.from(hashB64, "base64");
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  const derived = await scryptAsync(password.normalize("NFKC"), salt, expected.length, { N, r, p });
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * How the login password is configured. `APP_PASSWORD_HASH` is preferred: the password itself is
 * never stored, so reading the environment does not hand someone a password they might have reused
 * elsewhere. `APP_PASSWORD` is the plain alternative for setting this up without a terminal to hand,
 * since scrypt is not available in a browser.
 */
export type PasswordConfig =
  | { kind: "hash"; hash: string }
  | { kind: "plain"; password: string }
  | { kind: "missing" }
  | { kind: "malformed" };

/** Does this look like the `scrypt$N$r$p$salt$hash` format hashPassword produces? */
export function looksLikeScryptHash(value: string): boolean {
  const parts = value.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts;
  if (![n, r, p].every((v) => v && /^\d+$/.test(v))) return false;
  return !!salt && !!hash;
}

export function readPasswordConfig(env: Record<string, string | undefined> = process.env): PasswordConfig {
  const hash = env.APP_PASSWORD_HASH?.trim();
  if (hash) return looksLikeScryptHash(hash) ? { kind: "hash", hash } : { kind: "malformed" };
  const plain = env.APP_PASSWORD?.trim();
  if (plain) return { kind: "plain", password: plain };
  return { kind: "missing" };
}

export async function checkPassword(input: string, config: PasswordConfig): Promise<boolean> {
  if (config.kind === "hash") return verifyPassword(input, config.hash);
  if (config.kind === "plain") {
    const a = Buffer.from(input.normalize("NFKC"), "utf8");
    const b = Buffer.from(config.password.normalize("NFKC"), "utf8");
    // Compare hashes of the two so the comparison is constant time regardless of length.
    return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
  }
  return false;
}
