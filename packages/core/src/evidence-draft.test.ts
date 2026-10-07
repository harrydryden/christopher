import { describe, expect, it } from "vitest";
import { CvLibrarySchema, groupCvLibrary, type CvLibrary } from "./cv";
import { appendConfirmedEvidence, evidenceDraftFingerprint, validateEvidenceDraft, type EvidenceDraftInput } from "./evidence-draft";

const input: EvidenceDraftInput = {
  question: "What changed?", answer: "I helped the team reduce handover time by around 20%.",
  destination: { kind: "employment", id: "job-1" }, baseVersion: 2,
  source: "library", questionId: "result", facet: "outcome",
  job: { company: "Example Company", title: "Operations lead", startDate: "2022", endDate: "", current: true },
};

describe("grounded evidence proposals", () => {
  const plan = (wording: string) => ({ wording, quotes: [input.answer] });
  it("accepts supported, qualified wording and rejects fabricated quantities and ownership", () => {
    expect(validateEvidenceDraft(input, plan("Helped the team reduce handover time by around 20%."))?.wording)
      .toBe("Helped the team reduce handover time by around 20%.");
    expect(validateEvidenceDraft(input, plan("Reduced handover time by 20%."))).toBeNull();
    expect(validateEvidenceDraft(input, plan("Reduced handover time by around 30%."))).toBeNull();
    expect(validateEvidenceDraft(input, plan("Led the team to reduce handover time by around 20%."))).toBeNull();
    expect(validateEvidenceDraft(input, { wording: "Helped reduce handover time.", quotes: ["made up quote"] })).toBeNull();
  });

  it("does not turn a team claim into an individual leadership claim", () => {
    const team = { ...input, answer: "We led the implementation across two teams." };
    expect(validateEvidenceDraft(team, { wording: "Led the implementation across two teams.", quotes: [team.answer] })).toBeNull();
  });

  it("keys repeated requests to the same source, version and answer", () => {
    expect(evidenceDraftFingerprint(input)).toBe(evidenceDraftFingerprint({ ...input }));
    expect(evidenceDraftFingerprint(input)).not.toBe(evidenceDraftFingerprint({ ...input, answer: "We reduced handover time." }));
    expect(evidenceDraftFingerprint(input)).not.toBe(evidenceDraftFingerprint({ ...input, baseVersion: 3 }));
  });
});

it("appends only reviewed wording and marks that exact row confirmed", () => {
  const library: CvLibrary = { name: "Example", contact: "", profile: "", structuredExperience: true,
    employment: [{ id: "job-1", company: "Example Company", jobTitle: "Operations lead", startDate: "2022", endDate: "", current: true }],
    entries: [{ id: "entry-1", kind: "experience", heading: "Operations lead · Example Company", employmentId: "job-1",
      details: "Managed the rota.", confirmedResponsibilities: ["Managed the rota."] }] };
  const result = appendConfirmedEvidence(library, input, "Helped the team reduce handover time by around 20%.", "new-id");
  expect(result.entries[0]?.details).toBe("Managed the rota.\nHelped the team reduce handover time by around 20%.");
  expect(result.entries[0]?.confirmedResponsibilities).toEqual(["Managed the rota.", "Helped the team reduce handover time by around 20%."]);
  expect(() => appendConfirmedEvidence(result, input, "Helped the team reduce handover time by around 20%.", "new-id"))
    .toThrow("already in Experience");
  expect(() => appendConfirmedEvidence(library, input, "Two\nrows", "new-id")).toThrow("one concise evidence row");
});

it("lets a first job be saved without invented evidence, while a CV still needs confirmed wording", () => {
  const firstJob = CvLibrarySchema.parse({ name: "Example", contact: "", profile: "", structuredExperience: true,
    employment: [{ id: "job-1", company: "Example Company", jobTitle: "Operations lead", startDate: "2022", endDate: "", current: true }],
    entries: [] });
  expect(() => groupCvLibrary(firstJob)).toThrow("Confirm at least one responsibility");
  const confirmed = appendConfirmedEvidence(firstJob, input, "Helped the team reduce handover time by around 20%.", "entry-1");
  expect(CvLibrarySchema.safeParse(confirmed).success).toBe(true);
  expect(groupCvLibrary(confirmed).entries).toHaveLength(1);
});
