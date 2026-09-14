import { expect, it } from "vitest";
import { cvVersionLabel } from "./cv-version";
it("uses the requested short month, padded date and UTC allocation day", () => {
  expect(cvVersionLabel("2026-09-19T12:00:00Z", 1)).toBe("19-Sep-V1");
  expect(cvVersionLabel("2026-09-19T23:59:59Z", 2)).toBe("19-Sep-V2");
  expect(cvVersionLabel("2026-01-01T00:00:00Z", 1)).toBe("01-Jan-V1");
  expect(cvVersionLabel("2026-09-20T00:30:00+02:00", 12)).toBe("19-Sep-V12");
});
