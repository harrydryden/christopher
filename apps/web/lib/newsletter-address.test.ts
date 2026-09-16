import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addressTokenFor, inboundDomain, localPartOf, sourceIdForAddress, subscribeAddressFor } from "./newsletter-address";

const a = "11111111-1111-1111-1111-111111111111";
const b = "22222222-2222-2222-2222-222222222222";

beforeEach(() => { vi.stubEnv("NEWSLETTER_INGEST_SECRET", "test-secret"); vi.stubEnv("NEWSLETTER_INBOUND_DOMAIN", "inbox.example.com"); });
afterEach(() => vi.unstubAllEnvs());

describe("newsletter delivery addresses", () => {
  it("derives a stable address that differs per source and per secret", () => {
    expect(subscribeAddressFor(a)).toBe(`${addressTokenFor(a, "test-secret")}@inbox.example.com`);
    expect(subscribeAddressFor(a)).toBe(subscribeAddressFor(a));
    expect(addressTokenFor(a, "test-secret")).not.toBe(addressTokenFor(b, "test-secret"));
    expect(addressTokenFor(a, "test-secret")).not.toBe(addressTokenFor(a, "other-secret"));
    expect(addressTokenFor(a, "test-secret")).toMatch(/^[a-z0-9]{14}$/);
  });
  it("offers no address until inbound email is configured", () => {
    vi.stubEnv("NEWSLETTER_INBOUND_DOMAIN", "");
    expect(subscribeAddressFor(a)).toBeNull();
    expect(inboundDomain()).toBeNull();
    vi.stubEnv("NEWSLETTER_INBOUND_DOMAIN", "not a domain");
    expect(inboundDomain()).toBeNull();
    vi.stubEnv("NEWSLETTER_INBOUND_DOMAIN", "@inbox.example.com");
    expect(inboundDomain()).toBe("inbox.example.com");
  });
  it("reads the recipient out of a real To header", () => {
    const token = addressTokenFor(a, "test-secret");
    expect(localPartOf(`Christopher <${token}+linkedin@inbox.example.com>`)).toBe(token);
    expect(sourceIdForAddress(`"Feed" <${token}@inbox.example.com>`, [b, a], "test-secret")).toBe(a);
    expect(sourceIdForAddress(`${token}@inbox.example.com`, [b], "test-secret")).toBeNull();
    expect(sourceIdForAddress("nobody@inbox.example.com", [a, b], "test-secret")).toBeNull();
  });
});
