import { expect, it } from "vitest";
import { dateTimeFormatter } from "./intl";
import { localDateParts } from "./settings";

it("reuses equivalent options without confusing different time zones", () => {
  const london = dateTimeFormatter({ timeZone: "Europe/London", hour: "2-digit" });
  expect(dateTimeFormatter({ hour: "2-digit", timeZone: "Europe/London" })).toBe(london);
  const date = new Date("2026-07-01T12:00:00Z");
  expect(london.format(date)).toBe("13");
  expect(dateTimeFormatter({ timeZone: "UTC", hour: "2-digit" }).format(date)).toBe("12");
  expect(() => dateTimeFormatter({ timeZone: "Mars/Olympus" })).toThrow(RangeError);
});

it("does not cache date results across midnight or daylight-saving transitions", () => {
  expect(localDateParts(new Date("2026-03-29T00:59:00Z"), "Europe/London").hm).toBe("00:59");
  expect(localDateParts(new Date("2026-03-29T01:00:00Z"), "Europe/London").hm).toBe("02:00");
  expect(localDateParts(new Date("2026-07-01T23:00:00Z"), "Europe/London").ymd).toBe("2026-07-02");
});

it("evicts old formatters instead of growing indefinitely and preserves formatting after eviction", () => {
  const options = { timeZone: "UTC", year: "numeric", era: "long" } as const;
  const first = dateTimeFormatter(options);
  for (const timeZone of Intl.supportedValuesOf("timeZone").slice(0, 40)) {
    dateTimeFormatter({ timeZone, minute: "2-digit" });
  }
  const recreated = dateTimeFormatter(options);
  expect(recreated).not.toBe(first);
  const date = new Date("2026-01-01T00:00:00Z");
  expect(recreated.format(date)).toBe(first.format(date));
});
