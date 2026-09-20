import { expect, it } from "vitest";
import type { CvLibrary } from "@christopher/core";
import { gapDestinationValue } from "@/components/CvGapQuiz";

it("maps a structured experience suggestion to its editable employment record", () => {
  const library: CvLibrary = {
    name: "Example", contact: "", profile: "Leader", structuredExperience: true,
    employment: [{ id: "job:1", company: "Acme", jobTitle: "Director", startDate: "2022", endDate: "", current: true }],
    entries: [{ id: "grouped-experience", kind: "experience", heading: "Director · Acme", details: "Led delivery", employmentId: "job:1", confirmedResponsibilities: ["Led delivery"] }],
  };
  expect(gapDestinationValue({ kind: "evidence", entryId: "grouped-experience" }, library)).toBe("employment:job:1");
});
