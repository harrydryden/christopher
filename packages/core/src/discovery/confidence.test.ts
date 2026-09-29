import { describe, expect, it } from "vitest";
import { AUTO_ACCEPT_CONFIDENCE, confidenceFor } from "./confidence";

describe("verified board identity confidence", () => {
  it("keeps a named company mismatch below automatic acceptance despite corroborating methods", () => {
    const candidate = { method: "ats_network", companyName: "Zebra Logistics", count: 120 };
    const single = confidenceFor(candidate, { homepageCompanyName: "Acme Robotics", methodCount: 1 });
    const corroborated = confidenceFor(candidate, { homepageCompanyName: "Acme Robotics", methodCount: 5 });
    expect(single).toBeLessThan(AUTO_ACCEPT_CONFIDENCE);
    expect(corroborated).toBeLessThan(AUTO_ACCEPT_CONFIDENCE);
    expect(corroborated).toBeGreaterThanOrEqual(single);
    expect(confidenceFor({ ...candidate, companyName: "Acme Robotics" },
      { homepageCompanyName: "Acme Robotics", methodCount: 5 })).toBeGreaterThanOrEqual(AUTO_ACCEPT_CONFIDENCE);
  });
});
