/**
 * Password hashing and the rules a new password must meet. Hashing lives in @christopher/core
 * so the worker CLI and the interface agree on the format; this checks the re-export.
 */
import { describe, expect, it } from "vitest";
import { hashPassword, looksLikeScryptHash, needsRehash, passwordProblem, verifyPassword } from "./password";

describe("hashing", () => {
  it("accepts the right password and rejects the wrong one", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("produces a different hash each time, and both verify", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same-password", a)).toBe(true);
    expect(await verifyPassword("same-password", b)).toBe(true);
  });

  it("normalises unicode so an equivalent password still works", async () => {
    const hash = await hashPassword("café au lait");
    expect(await verifyPassword("café au lait", hash)).toBe(true);
  });

  it("rejects a malformed stored hash instead of throwing", async () => {
    expect(await verifyPassword("anything", "48291057384610293847561029384756")).toBe(false);
    expect(await verifyPassword("anything", "")).toBe(false);
  });
});

describe("needsRehash", () => {
  it("flags hashes made with a weaker cost than the current one, and nothing else", async () => {
    const current = await hashPassword("x");
    expect(needsRehash(current)).toBe(false);
    const [, n, r, p, salt, hash] = current.split("$");
    expect(needsRehash(`scrypt$${Number(n) / 2}$${r}$${p}$${salt}$${hash}`)).toBe(true);
    expect(needsRehash(`scrypt$${n}$4$${p}$${salt}$${hash}`)).toBe(true);
    expect(needsRehash("not a hash")).toBe(false);
  });
});

describe("looksLikeScryptHash", () => {
  it("recognises a real hash", async () => {
    expect(looksLikeScryptHash(await hashPassword("x"))).toBe(true);
  });

  it("rejects things people paste in by mistake", () => {
    expect(looksLikeScryptHash("48291057384610293847561029384756")).toBe(false);
    expect(looksLikeScryptHash("my-password")).toBe(false);
    expect(looksLikeScryptHash("scrypt$16384$8$1$onlyfiveparts")).toBe(false);
    expect(looksLikeScryptHash("bcrypt$16384$8$1$salt$hash")).toBe(false);
    expect(looksLikeScryptHash("scrypt$N$r$p$salt$hash")).toBe(false);
    expect(looksLikeScryptHash("")).toBe(false);
  });
});

describe("passwordProblem", () => {
  it("requires a minimum length and caps the maximum", () => {
    expect(passwordProblem("short")).toMatch(/at least/);
    expect(passwordProblem("x".repeat(300))).toMatch(/at most/);
    expect(passwordProblem("a perfectly fine passphrase")).toBeNull();
  });
});
