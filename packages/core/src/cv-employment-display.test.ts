import { expect, it } from "vitest";
import type { CvContent, CvLibrary } from "./cv";
import { cvEmploymentDisplay } from "./cv-employment-display";

const jobs = [
  { id: "job-1", company: "Acme", jobTitle: "Head of Operations", startDate: "2022-01", endDate: "", current: true,
    industryDescriptions: "Healthcare, Software" },
  { id: "job-2", company: "Acme", jobTitle: "Manager", startDate: "2018", endDate: "2021", current: false,
    industryDescriptions: "Healthcare, Software" },
];
const library = { name: "Example", contact: "", profile: "", employment: jobs,
  entries: [{ id: "new", kind: "experience", heading: "Head of Operations", details: "Led a team", employmentId: "job-1" },
    { id: "old", kind: "experience", heading: "Manager", details: "Managed services", employmentId: "job-2" }] } as CvLibrary;
const content = { name: "Example", contact: "", summary: "Operations leader", sections: [
  { entryId: "new", kind: "experience", heading: "Head of Operations · Acme · Jan 2022 – Present",
    industryDescriptions: ["Software", "Healthcare"], bullets: ["Led a team"] },
  { entryId: "old", kind: "experience", heading: "Manager · Acme · 2018 – 2021",
    industryDescriptions: ["Healthcare"], bullets: ["Managed services"] },
], gaps: [] } as CvContent;

it("hydrates existing canonical headings from the linked employment snapshot and shares one selected industry", () => {
  const display = cvEmploymentDisplay(content, library);
  expect(display.get("new")).toEqual({ heading: "Acme · Head of Operations · Jan 2022 – Present", industry: "Software" });
  expect(display.get("old")).toEqual({ heading: "Acme · Manager · 2018 – 2021", industry: "Software" });
  expect(content.sections[0]!.heading).toBe("Head of Operations · Acme · Jan 2022 – Present");
});

it("keeps a manually edited heading, rejects an unsupported descriptor, and never infers an absent industry", () => {
  const manual = { ...content, sections: [{ ...content.sections[0]!, heading: "Regional operations lead",
    industryDescriptions: ["Regulated services"] }, content.sections[1]!] } as CvContent;
  const display = cvEmploymentDisplay(manual, library);
  expect(display.get("new")).toEqual({ heading: "Regional operations lead", industry: "Healthcare" });
  expect(display.get("old")?.industry).toBe("Healthcare");
  const unknown = { ...library, employment: jobs.map(job => ({ ...job, industryDescriptions: "" })) } as CvLibrary;
  expect(cvEmploymentDisplay(content, unknown).get("new")?.industry).toBeNull();
  expect(cvEmploymentDisplay(content, { ...library, employment: [] }).size).toBe(0);
});

it("does not revive a sector that exists only on an omitted role at the same company", () => {
  const printed = { ...content, sections: [{ ...content.sections[0]!, industryDescriptions: [] }] } as CvContent;
  const source = { ...library, employment: [
    { ...jobs[0]!, industryDescriptions: "" },
    { ...jobs[1]!, industryDescriptions: "Oil and gas" },
  ] } as CvLibrary;
  expect(cvEmploymentDisplay(printed, source).get("new")?.industry).toBeNull();
});
