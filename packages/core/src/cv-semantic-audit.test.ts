import { expect, it } from "vitest";
import { materialiseCv, type CvLibrary } from "./cv";
import { DEFAULT_CV_THEME } from "./cv-theme-values";
import { cvSemanticAuditIdentity } from "./cv-semantic-audit";
import { cvEvidenceItems } from "./cv-assessment";

const library: CvLibrary = { name: "Ada", contact: "London", profile: "Operations leader",
  entries: [{ id: "role", kind: "experience", heading: "Director", details: "Led operations.",
    confirmedResponsibilities: ["Led operations."] }] };
const content = materialiseCv(library, { summary: "Operations leader", sections: [
  { entryId: "role", bullets: ["Led operations."] }], gaps: [] });
const input = { content, library, rubric: { requirements: [
  { id: "r1", label: "Lead operations", quote: "Lead operations", importance: "essential" as const,
    category: "experience" as const }], caveats: [] }, description: "Lead operations",
  reviewRoute: { model: "review-model", effort: "high", serviceTier: "standard" },
  reviewPromptVersion: "review-v1" };

it("reuses only the same semantic claims, confirmed evidence, role and effective review route", () => {
  const base = cvSemanticAuditIdentity(input);
  expect(cvSemanticAuditIdentity({ ...input, content: { ...content,
    theme: { ...DEFAULT_CV_THEME, maxPages: 2, bodySizePt: 12 }, fitNotes: ["Layout only"] } })).toBe(base);
  expect(cvSemanticAuditIdentity({ ...input, content: { ...content, sections: content.sections.map(section => ({
    ...section, bulletSignposts: ["Leadership"] })) } })).not.toBe(base);
  expect(cvSemanticAuditIdentity({ ...input, content: { ...content, summary: "Different claim" } })).not.toBe(base);
  expect(cvSemanticAuditIdentity({ ...input, content: { ...content, sections: content.sections.map(section => ({
    ...section, heading: "Changed role heading" })) } })).not.toBe(base);
  expect(cvSemanticAuditIdentity({ ...input, library: { ...library, entries: [{ ...library.entries[0]!,
    details: "Led a different operation.", confirmedResponsibilities: ["Led a different operation."] }] } })).not.toBe(base);
  expect(cvSemanticAuditIdentity({ ...input, rubric: { ...input.rubric, caveats: ["New caveat"] } })).not.toBe(base);
  expect(cvSemanticAuditIdentity({ ...input, description: "Different role" })).not.toBe(base);
  expect(cvSemanticAuditIdentity({ ...input, reviewRoute: { ...input.reviewRoute, effort: "medium" } })).not.toBe(base);
  expect(cvSemanticAuditIdentity({ ...input, reviewRoute: { ...input.reviewRoute, model: "new-model" } })).not.toBe(base);
  expect(cvSemanticAuditIdentity({ ...input, reviewRoute: { ...input.reviewRoute, serviceTier: "priority" } })).not.toBe(base);
  expect(cvSemanticAuditIdentity({ ...input, reviewPromptVersion: "review-v2" })).not.toBe(base);
  const eligibleEvidence = cvEvidenceItems(library);
  expect(cvSemanticAuditIdentity({ ...input, eligibleEvidence, sourcePolicy: "omit:other" })).not.toBe(base);
  expect(cvSemanticAuditIdentity({ ...input, eligibleEvidence: eligibleEvidence.slice(1),
    sourcePolicy: "legacy" })).not.toBe(base);
  const targeted = cvSemanticAuditIdentity({ ...input, eligibleEvidence: [], sourcePolicy: "omit:role" });
  expect(cvSemanticAuditIdentity({ ...input, eligibleEvidence: [], sourcePolicy: "omit:role",
    library: { ...library, entries: [{ ...library.entries[0]!, details: "Changed omitted role evidence.",
      confirmedResponsibilities: ["Changed omitted role evidence."] }] } })).not.toBe(targeted);
  expect(cvSemanticAuditIdentity({ ...input, eligibleEvidence, sourcePolicy: "legacy",
    content: { ...content, theme: { ...DEFAULT_CV_THEME, maxPages: 2, bodySizePt: 12 } } }))
    .toBe(cvSemanticAuditIdentity({ ...input, eligibleEvidence, sourcePolicy: "legacy" }));
});
