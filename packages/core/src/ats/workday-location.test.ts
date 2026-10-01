import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateLocation } from "../gate";
import { createFakeFetchContext } from "../testing";
import { fetchWorkdayLocations, workday, workdaySpec } from "./workday";

const evidence = new URL("../../../../docs/reviews/2026-10-01/implementation-evidence/workday-region/", import.meta.url);
const listing = JSON.parse(readFileSync(new URL("workday-page.json", evidence), "utf8")) as {
  jobPostings: Array<{ externalPath: string; locationsText: string }>;
};
const detail = JSON.parse(readFileSync(new URL("workday-multi-location-detail.json", evidence), "utf8")) as Record<string, unknown>;
const counted = listing.jobPostings.find((posting) => posting.locationsText === "70 Locations")!;
const spec = workdaySpec("workday.wd5.myworkdayjobs.com", "workday", "Workday");
const apiUrl = "https://workday.wd5.myworkdayjobs.com/wday/cxs/workday/Workday/jobs";
const detailUrl = `https://workday.wd5.myworkdayjobs.com/wday/cxs/workday/Workday${counted.externalPath}`;
const postingUrl = `https://workday.wd5.myworkdayjobs.com/Workday${counted.externalPath}`;

describe("Workday counted locations", () => {
  it("holds a 70-place listing pending, then reads the captured 70-place detail exactly once", async () => {
    const ctx = createFakeFetchContext({ routes: {
      [apiUrl]: { body: { total: 1, jobPostings: [counted] } },
      [detailUrl]: { body: detail },
    } });
    const [posting] = await workday.fetchPostings(spec, ctx);
    expect(posting).toMatchObject({ url: postingUrl, locationLabel: "70 Locations", locationResolution: "pending" });
    expect(posting!.location).toBeUndefined();
    expect(posting!.locations).toBeUndefined();
    expect(evaluateLocation(posting!, { locationTerms: ["Boston"], includeRemote: true }).ok).toBe(false);
    const resolved = await fetchWorkdayLocations(spec, posting!, ctx);
    expect(resolved.location).toBe("USA, GA, Atlanta");
    expect(resolved.locations).toHaveLength(70);
    expect(resolved.locations).toContain("USA, MA, Boston");
    expect(resolved.locations).toContain("USA, WA, Seattle");
    const enriched = { ...posting!, ...resolved, locationResolution: "resolved" as const };
    expect(evaluateLocation(enriched, { locationTerms: ["Boston"], includeRemote: true }).ok).toBe(true);
    expect(evaluateLocation(enriched, { locationTerms: ["UK"], includeRemote: true }).ok).toBe(false);
    expect(ctx.requestLog.map((request) => [request.method, request.url])).toEqual([["POST", apiUrl], ["GET", detailUrl]]);
  });

  it("keeps verification a one-page listing probe with no detail request", async () => {
    const ctx = createFakeFetchContext({ routes: { [apiUrl]: { body: { total: 1, jobPostings: [counted] } } } });
    expect((await workday.verify(spec, ctx)).ok).toBe(true);
    expect(ctx.requestLog.map((request) => request.url)).toEqual([apiUrl]);
  });

  it.each([
    "https://evil.example/Workday/job/role",
    "https://workday.wd5.myworkdayjobs.com/Other/job/role",
    "https://workday.wd5.myworkdayjobs.com/Workday/jobs/role",
    "https://workday.wd5.myworkdayjobs.com/Workday/job/%2e%2e/role",
    "https://workday.wd5.myworkdayjobs.com/Workday/job/%2Fother",
  ])("rejects an out-of-scope detail path before fetching: %s", async (url) => {
    const ctx = createFakeFetchContext({ routes: {} });
    await expect(fetchWorkdayLocations(spec, { url, locationLabel: "2 Locations" }, ctx)).rejects.toThrow();
    expect(ctx.requestLog).toHaveLength(0);
  });

  it("rejects a forged source tenant or host before fetching, and a redirected detail response", async () => {
    for (const forged of [
      { ...spec, atsSlug: "other" },
      { ...spec, atsSite: "evil.example|Workday" },
      { ...spec, atsSite: "workday.wd5.myworkdayjobs.com|../Other" },
    ]) {
      const ctx = createFakeFetchContext({ routes: {} });
      await expect(fetchWorkdayLocations(forged, { url: postingUrl, locationLabel: "2 Locations" }, ctx)).rejects.toThrow();
      expect(ctx.requestLog).toHaveLength(0);
    }
    const redirected = createFakeFetchContext({ routes: { [detailUrl]: { body: detail, url: "https://evil.example/detail" } } });
    await expect(fetchWorkdayLocations(spec, { url: postingUrl, locationLabel: "70 Locations" }, redirected)).rejects.toThrow(/redirected/);
    expect(redirected.requestLog).toHaveLength(1);
  });

  it("rejects incomplete, duplicated, malformed and over-budget counted lists", async () => {
    for (const bad of [
      { jobPostingInfo: { location: "USA, GA, Atlanta", additionalLocations: [] } },
      { jobPostingInfo: { location: "USA, GA, Atlanta", additionalLocations: ["USA, GA, Atlanta"] } },
      { jobPostingInfo: { location: "USA, GA, Atlanta", additionalLocations: ["  "] } },
      { jobPostingInfo: { location: "USA, GA, Atlanta", additionalLocations: ["2 Locations"] } },
      { jobPostingInfo: { location: "USA, GA, Atlanta", additionalLocations: "USA, MA, Boston" } },
    ]) {
      const ctx = createFakeFetchContext({ routes: { [detailUrl]: { body: bad } } });
      await expect(fetchWorkdayLocations(spec, { url: postingUrl, locationLabel: "2 Locations" }, ctx)).rejects.toThrow();
      expect(ctx.requestLog).toHaveLength(1);
    }
    const ctx = createFakeFetchContext({ routes: {} });
    await expect(fetchWorkdayLocations(spec, { url: postingUrl, locationLabel: "1001 Locations" }, ctx)).rejects.toThrow();
    expect(ctx.requestLog).toHaveLength(0);
    const [large] = await workday.fetchPostings(spec, createFakeFetchContext({ routes: { [apiUrl]: { body: {
      total: 1, jobPostings: [{ title: "Large role", externalPath: counted.externalPath, locationsText: "1001 Locations" }],
    } } } }));
    expect(large).toMatchObject({ locationResolution: "pending", locationLabel: "1001 Locations" });
    expect(large!.location).toBeUndefined();
  });
});
