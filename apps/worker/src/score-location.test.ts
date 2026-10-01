import { expect, it } from "vitest";
import { scoreLocationInput } from "./score-location";

it("keeps a score input stable when the source only reorders or repeats listed places", () => {
  const first = scoreLocationInput({ location: "Boston", locations: ["Boston", "Atlanta"], locationResolution: "resolved" });
  const reordered = scoreLocationInput({ location: "Atlanta", locations: ["Atlanta", " Boston ", "Boston"], locationResolution: "resolved" });
  expect(reordered).toEqual(first);
  expect(first).toEqual({ locations: ["Atlanta", "Boston"] });
});

it("does not present retained names as current evidence while Workday detail is unverified", () => {
  const retained = { location: "Atlanta", locations: ["Atlanta", "Boston"] };
  expect(scoreLocationInput({ ...retained, locationResolution: "pending" })).toEqual({ locationStatus: "pending" });
  expect(scoreLocationInput({ ...retained, locationResolution: "unavailable" })).toEqual({ locationStatus: "unavailable" });
});
