import { expect, it } from "vitest";
import { formatClock, formatCount, formatUsd, shortDate } from "./format";

it("preserves UK currency, grouping and UTC budget-date presentation", () => {
  expect(formatUsd(1234.5)).toBe("US$1,234.50");
  expect(formatCount(1234.6)).toBe("1,235");
  expect(shortDate(new Date("2026-07-01T23:59:00Z"))).toBe("1 Jul");
});

it("keeps clock precision and time zones independent across repeated calls", () => {
  const date = new Date("2026-07-01T00:03:04Z");
  expect(formatClock(date)).toBe("00:03:04");
  expect(formatClock(date, "Europe/London", false)).toBe("01:03");
  expect(formatClock(date)).toBe("00:03:04");
});
