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

it("keeps all thousand verified names, including a relevant last one, in the score input", () => {
  const locations = [...Array.from({ length: 999 }, (_, i) => `City ${i}`), "Boston, Massachusetts"];
  const result = scoreLocationInput({ location: locations[0]!, locations, locationResolution: "resolved" });
  expect(result.locations).toHaveLength(1000);
  expect(result.locations).toContain("Boston, Massachusetts");
});
