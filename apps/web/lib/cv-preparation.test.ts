import { expect, it } from "vitest";
import type { CvLibrary } from "@col/core/cv";
import type { CvTargetingBriefV1 } from "@col/core/cv-targeting";
import type { CvAssessment } from "@col/core/cv-assessment";
import { compareCvWithLinkedIn, cvEmphasisScan, cvInterviewCards, cvQuickScan, linkedInImportHasConfirmedEvidence } from "./cv-preparation";

const library: CvLibrary = { name: "Ada", contact: "", profile: "Analyst", employment: [
  { id: "job-1", company: "Acme", jobTitle: "Analyst", startDate: "2020", endDate: "2022", current: false },
], entries: [{ id: "role-1", kind: "experience", heading: "Responsibilities and outcomes", details: "Built reports.",
  employmentId: "job-1", confirmedResponsibilities: ["Built reports."] }] };

it("compares only a uniquely matched, anchored LinkedIn upload", () => {
  const proposal = { employment: [{ id: "p1", company: "Acme", title: "Senior Analyst", startDate: "2020",
    endDate: "2022", current: false, quote: "Acme Senior Analyst 2020 to 2022", responsibilities: [] }],
    education: [], skills: [] };
  const checked = compareCvWithLinkedIn(library, proposal, "Acme Senior Analyst 2020 to 2022");
  expect(checked).toMatchObject([{ field: "Acme · Job title", status: "needs_review" },
    { field: "Acme · Start date", status: "corroborating" },
    { field: "Acme · End date", status: "corroborating" }]);
  expect(compareCvWithLinkedIn(library, proposal, "Unrelated upload")).toEqual([]);
  expect(compareCvWithLinkedIn({ ...library, employment: [...library.employment!, library.employment![0]!] },
    proposal, "Acme Senior Analyst 2020 to 2022")).toEqual([]);
  expect(compareCvWithLinkedIn(library, { ...proposal, employment: [{ ...proposal.employment[0]!,
    quote: "A senior analyst from 2020 to 2022" }] },
    "Acme Senior Analyst 2020 to 2022. A senior analyst from 2020 to 2022")).toEqual([]);
  expect(compareCvWithLinkedIn(library, { ...proposal, employment: [{ ...proposal.employment[0]!,
    startDate: "2020-06", quote: "Acme Senior Analyst 2020 to 2022" }] },
    "Acme Senior Analyst 2020 to 2022").some(item => item.field.endsWith("Start date"))).toBe(false);
});

it("does not treat a resolved but dismissed or unconfirmed LinkedIn upload as reviewed evidence", () => {
  const id = "62cf7aae-5521-48a9-a043-93f1a14f61cd";
  expect(linkedInImportHasConfirmedEvidence(library, id, new Date())).toBe(false);
  const imported = { ...library, entries: [{ ...library.entries[0]!, id: `${id}:p1:evidence`, confirmedResponsibilities: [] }] };
  expect(linkedInImportHasConfirmedEvidence(imported, id, new Date())).toBe(false);
  expect(linkedInImportHasConfirmedEvidence({ ...imported, entries: [{ ...imported.entries[0]!,
    confirmedResponsibilities: ["Built reports."] }] }, id, null)).toBe(false);
  expect(linkedInImportHasConfirmedEvidence({ ...imported, entries: [{ ...imported.entries[0]!,
    confirmedResponsibilities: ["Built reports."] }] }, id, new Date())).toBe(true);
});

it("maps selected priorities only through current demonstrated audited claims and measured pages", () => {
  const brief = { priority: { emphasisRequirementIds: ["r1", "r2", "r3"] } } as CvTargetingBriefV1;
  const assessment = { rubric: { requirements: ["r1", "r2", "r3"].map(id => ({ id, label: id })) },
    review: { matches: [
      { requirementId: "r1", status: "demonstrated", cvEvidence: [{ id: "section:a:0" }] },
      { requirementId: "r2", status: "demonstrated", cvEvidence: [{ id: "section:b:0" }] },
      { requirementId: "r3", status: "partial", cvEvidence: [{ id: "section:c:0" }] },
    ], claims: ["section:a:0", "section:b:0", "section:c:0"].map(claimId => ({ claimId, status: "supported" })) } } as CvAssessment;
  const layout = { claimPages: [
    { claimId: "section:a:0", startPage: 1, endPage: 1 },
    { claimId: "section:b:0", startPage: 2, endPage: 2 },
    { claimId: "section:c:0", startPage: 1, endPage: 1 },
  ], summaryLines: 2, firstPageEntryIds: [], sectionPages: [] };
  expect(cvEmphasisScan(brief, assessment, layout).map(item => item.status)).toEqual(["first_page", "elsewhere", "unconfirmed"]);
  expect(cvEmphasisScan(brief, null, layout)).toEqual([]);
  assessment.review.claims[0]!.status = "unsupported";
  expect(cvEmphasisScan(brief, assessment, layout)[0]?.status).toBe("unconfirmed");
});

it("uses only confirmed omitted rows for interview preparation and the exact first-page claims for scan", () => {
  const brief = { entries: [{ entryId: "role-1", treatment: "omit" }] } as CvTargetingBriefV1;
  expect(cvInterviewCards(library, brief)).toMatchObject([{ entryId: "role-1", employer: "Acme",
    evidence: "Built reports.", relevance: "additional" }]);
  expect(cvInterviewCards(library, brief, ["entry:role-1"])[0]?.relevance).toBe("additional");
  expect(cvInterviewCards(library, brief, ["entry:role-1:row:0"])[0]?.relevance).toBe("role_mapped");
  expect(cvInterviewCards(library, { entries: [{ entryId: "role-1", treatment: "feature" }] } as CvTargetingBriefV1)).toEqual([]);
  const scan = cvQuickScan({ name: "Ada", contact: "", summary: "Analyst.", gaps: [], sections: [
    { entryId: "role-1", kind: "experience", heading: "Analyst · Acme", bullets: ["Built reports.", "Led a team."] },
  ] }, { summaryLines: 1, firstPageEntryIds: ["role-1"], sectionPages: [{ entryId: "role-1", startPage: 1, endPage: 2 }],
    claimPages: [{ claimId: "section:role-1:0", startPage: 1, endPage: 1 },
      { claimId: "section:role-1:1", startPage: 2, endPage: 2 }] });
  expect(scan.firstPageClaims.map(item => item.text)).toEqual(["Built reports."]);
  expect(scan.wordCount).toBeGreaterThan(6); // Name and printed section heading count too.
});
