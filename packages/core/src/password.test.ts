/**
 * AVA_SCRYPT_N is a test-suite knob. Copied into a deployment it would make every new hash cheaper
 * to crack, and `needsRehash` would treat the weaker cost as current and never upgrade it.
 */
import { afterEach, expect, it, vi } from "vitest";
import { hashPassword, needsRehash, verifyPassword } from "./password";

afterEach(() => vi.unstubAllEnvs());

const costOf = (hash: string) => Number(hash.split("$")[1]);

it("honours the cheaper test cost outside production", async () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AVA_SCRYPT_N", "16384");
  const hash = await hashPassword("correct horse battery staple");
  expect(costOf(hash)).toBe(16384);
  expect(needsRehash(hash)).toBe(false);
});

it("ignores the override in production, and upgrades a hash made at the cheaper cost", async () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AVA_SCRYPT_N", "16384");
  const cheap = await hashPassword("correct horse battery staple");

  vi.stubEnv("NODE_ENV", "production");
  const hash = await hashPassword("correct horse battery staple");
  expect(costOf(hash)).toBe(1 << 17);
  expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  expect(needsRehash(cheap)).toBe(true);
  expect(needsRehash(hash)).toBe(false);
});
