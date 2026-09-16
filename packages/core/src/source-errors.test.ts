import { describe, expect, it } from "vitest";
import { importOnlyReason, isImportOnlySourceError } from "./source-errors";

describe("import-only sources", () => {
  it("recognises the refusals a retry can never get past", () => {
    expect(isImportOnlySourceError("robots.txt disallows https://www.linkedin.com/newsletters/x")).toBe(true);
    expect(isImportOnlySourceError("Sign-in required. Import the newsletter text instead.")).toBe(true);
    expect(isImportOnlySourceError("blocked (403) fetching https://example.com/")).toBe(true);
    expect(isImportOnlySourceError("HTTP 502: https://example.com/")).toBe(false);
    expect(isImportOnlySourceError("timeout fetching https://example.com/")).toBe(false);
    expect(isImportOnlySourceError(null)).toBe(false);
  });
  it("names the site in the explanation", () => {
    expect(importOnlyReason("https://www.linkedin.com/newsletters/x")).toMatch(/^LinkedIn does not allow/);
    expect(importOnlyReason("https://news.example.com/feed")).toMatch(/^news.example.com does not allow/);
    expect(importOnlyReason(null)).toMatch(/^This site does not allow/);
  });
});
