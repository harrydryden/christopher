import { describe, expect, it } from "vitest";
import { iconCandidates } from "./company-icon";

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
