import { beforeEach, expect, it, vi } from "vitest";
import { capacityQuoteToken, verifyCapacityQuoteToken } from "./company-capacity";

beforeEach(() => vi.stubEnv("SESSION_SECRET", "capacity-quote-test-secret"));

it("accepts a short-lived quote only for the account it names", () => {
  const payload = {
    userId: "00000000-0000-4000-8000-000000000001",
    subscriptionId: "sub_test",
    currentBlocks: 1,
    nextBlocks: 2,
    prorationDate: 1_800_000_000,
    expiresAt: 1_800_000_600,
  };
  const token = capacityQuoteToken(payload);
  expect(verifyCapacityQuoteToken(token, payload.userId, payload.prorationDate)).toEqual(payload);
  expect(verifyCapacityQuoteToken(token, "00000000-0000-4000-8000-000000000002", payload.prorationDate)).toBeNull();
  expect(verifyCapacityQuoteToken(token, payload.userId, payload.expiresAt + 1)).toBeNull();
});

it("rejects tampering and a jump of more than one block", () => {
  const token = capacityQuoteToken({
    userId: "00000000-0000-4000-8000-000000000001",
    subscriptionId: "sub_test",
    currentBlocks: 1,
    nextBlocks: 3,
    prorationDate: 1_800_000_000,
    expiresAt: 1_800_000_600,
  });
  expect(verifyCapacityQuoteToken(token, "00000000-0000-4000-8000-000000000001", 1_800_000_000)).toBeNull();
  expect(verifyCapacityQuoteToken(`${token.slice(0, -1)}x`, "00000000-0000-4000-8000-000000000001", 1_800_000_000)).toBeNull();
});
