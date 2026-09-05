/**
 * Login configuration. A malformed APP_PASSWORD_HASH previously rejected every password with no
 * explanation, which is a bad failure to debug from a login screen.
 */
import { describe, expect, it } from "vitest";
import { checkPassword, hashPassword, looksLikeScryptHash, readPasswordConfig, verifyPassword } from "./password";

describe("hashing", () => {
  it("accepts the right password and rejects the wrong one", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("produces a different hash each time, and both verify", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same", a)).toBe(true);
    expect(await verifyPassword("same", b)).toBe(true);
  });

  it("normalises unicode so an equivalent password still works", async () => {
    const hash = await hashPassword("café");
    expect(await verifyPassword("café", hash)).toBe(true);
  });
});

describe("looksLikeScryptHash", () => {
  it("recognises a real hash", async () => {
    expect(looksLikeScryptHash(await hashPassword("x"))).toBe(true);
  });

  it("rejects things people paste in by mistake", () => {
    // The failure this exists to catch: a random number pasted where a hash belongs.
    expect(looksLikeScryptHash("48291057384610293847561029384756")).toBe(false);
    expect(looksLikeScryptHash("my-password")).toBe(false);
    expect(looksLikeScryptHash("scrypt$16384$8$1$onlyfiveparts")).toBe(false);
    expect(looksLikeScryptHash("bcrypt$16384$8$1$salt$hash")).toBe(false);
    expect(looksLikeScryptHash("scrypt$N$r$p$salt$hash")).toBe(false);
    expect(looksLikeScryptHash("")).toBe(false);
  });
});

describe("readPasswordConfig", () => {
  it("prefers the hash when both are set", async () => {
    const hash = await hashPassword("from-hash");
    const config = readPasswordConfig({ APP_PASSWORD_HASH: hash, APP_PASSWORD: "from-plain" });
    expect(config.kind).toBe("hash");
    expect(await checkPassword("from-hash", config)).toBe(true);
    expect(await checkPassword("from-plain", config)).toBe(false);
  });

  it("falls back to a plain password", async () => {
    const config = readPasswordConfig({ APP_PASSWORD: "plain secret" });
    expect(config.kind).toBe("plain");
    expect(await checkPassword("plain secret", config)).toBe(true);
    expect(await checkPassword("plain secre", config)).toBe(false);
    expect(await checkPassword("", config)).toBe(false);
  });

  it("reports a malformed hash rather than silently rejecting everything", async () => {
    const config = readPasswordConfig({ APP_PASSWORD_HASH: "48291057384610293847561029384756" });
    expect(config.kind).toBe("malformed");
    expect(await checkPassword("48291057384610293847561029384756", config)).toBe(false);
  });

  it("ignores blank values and reports nothing configured", () => {
    expect(readPasswordConfig({}).kind).toBe("missing");
    expect(readPasswordConfig({ APP_PASSWORD_HASH: "  ", APP_PASSWORD: "  " }).kind).toBe("missing");
  });
});
