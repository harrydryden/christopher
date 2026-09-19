import { describe, expect, it } from "vitest";
import { companyIcon, companyLogoUrl, iconCandidates } from "./company-icon";

describe("iconCandidates", () => {
  it("tries the stored icon, the site's favicon, then the icon service", () => {
    expect(iconCandidates("https://cdn.hims.com/icon.png", "hims.com")).toEqual([
      "https://cdn.hims.com/icon.png",
      "https://hims.com/favicon.ico",
      "https://icons.duckduckgo.com/ip3/hims.com.ico",
    ]);
  });
  it("still has two candidates when the worker stored nothing", () => {
    expect(iconCandidates(null, "www.hims.com")).toEqual(["https://hims.com/favicon.ico", "https://icons.duckduckgo.com/ip3/hims.com.ico"]);
  });
  it("does not repeat a stored favicon.ico guess", () => {
    expect(iconCandidates("https://hims.com/favicon.ico", "hims.com")).toHaveLength(2);
  });
  it("ignores a domain that is not a hostname", () => {
    expect(iconCandidates(null, "not a host")).toEqual([]);
    expect(iconCandidates(null, null)).toEqual([]);
  });
});

describe("companyLogoUrl", () => {
  const fetched = new Date("2026-03-04T05:06:07.000Z");
  it("versions the served logo by its capture time", () => {
    expect(companyLogoUrl("c1", fetched)).toBe(`/api/companies/c1/logo?v=${fetched.getTime()}`);
    expect(companyLogoUrl("c1", fetched.toISOString())).toBe(`/api/companies/c1/logo?v=${fetched.getTime()}`);
  });
  it("has no URL to give until the worker has captured one", () => {
    expect(companyLogoUrl("c1", null)).toBeNull();
    expect(companyLogoUrl("c1", undefined)).toBeNull();
    expect(companyLogoUrl("c1", "not a date")).toBeNull();
  });
});

describe("companyIcon", () => {
  const company = { id: "c1", faviconUrl: "https://cdn.hims.com/icon.png", domain: "hims.com" };
  it("serves the captured logo when there is one, in preference to the remote favicon", () => {
    const fetched = new Date("2026-03-04T05:06:07.000Z");
    expect(companyIcon({ ...company, logoFetchedAt: fetched }))
      .toEqual({ src: `/api/companies/c1/logo?v=${fetched.getTime()}`, domain: "hims.com" });
  });
  it("falls back to the remote favicon, and then to the browser chain, until one is captured", () => {
    expect(companyIcon({ ...company, logoFetchedAt: null })).toEqual({ src: "https://cdn.hims.com/icon.png", domain: "hims.com" });
    const bare = companyIcon({ ...company, faviconUrl: null, logoFetchedAt: null });
    expect(bare.src).toBeNull();
    expect(iconCandidates(bare.src, bare.domain)).toEqual(["https://hims.com/favicon.ico", "https://icons.duckduckgo.com/ip3/hims.com.ico"]);
  });
});
