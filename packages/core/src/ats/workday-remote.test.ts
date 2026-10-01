import { describe, expect, it } from "vitest";
import { evaluateLocation } from "../gate";
import { createFakeFetchContext } from "../testing";
import { workday } from "./workday";

describe("Workday remote work options", () => {
  it("maps only explicit Remote while retaining location restrictions and textual fallback", async () => {
    const postings = [
      { title: "Remote without city", externalPath: "/job/remote-one", remoteType: "  rEmOtE  " },
      { title: "US remote", externalPath: "/job/us-remote", locationsText: "USA", remoteType: "Remote" },
      { title: "Hybrid", externalPath: "/job/hybrid", locationsText: "USA", remoteType: "Hybrid" },
      { title: "Flex", externalPath: "/job/flex", remoteType: "Flex" },
      { title: "Unknown", externalPath: "/job/unknown", remoteType: "Anywhere" },
      { title: "Textual remote", externalPath: "/job/textual", locationsText: "Remote - UK", remoteType: "On-site" },
    ];
    const spec = workday.specFromUrl("https://acme.wd1.myworkdayjobs.com/External")!;
    const ctx = createFakeFetchContext({ routes: {
      "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/External/jobs": {
        body: { total: postings.length, jobPostings: postings },
      },
    } });
    const mapped = await workday.fetchPostings(spec, ctx);
    expect(mapped.map((p) => p.remote)).toEqual([true, true, undefined, undefined, undefined, true]);
    const settings = { locationTerms: ["UK"], includeRemote: true };
    expect(evaluateLocation(mapped[0]!, settings).ok).toBe(true);
    expect(evaluateLocation(mapped[1]!, settings).ok).toBe(false);
    expect(evaluateLocation(mapped[2]!, settings).ok).toBe(false);
    expect(evaluateLocation(mapped[3]!, settings).ok).toBe(false);
    expect(evaluateLocation(mapped[4]!, settings).ok).toBe(false);
    expect(evaluateLocation(mapped[5]!, settings).ok).toBe(true);
  });
});
