import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { DEFAULT_CV_THEME, type CvContent } from "@col/core/cv";
import type { CvTargetingView } from "@col/core/cv-targeting";
import { CvEditionComparison } from "./CvEditionComparison";

const source: CvContent = {
  name: "Alex Example", contact: "alex@example.com", summary: "Operations leader.", gaps: [],
  theme: DEFAULT_CV_THEME,
  sections: [
    { entryId: "role:a", kind: "experience", heading: "Company A · Director", bullets: ["Improved delivery", "Reduced delays"],
      bulletSignposts: ["Delivery", "Speed"] },
    { entryId: "role:b", kind: "experience", heading: "Company B · Manager", bullets: ["Led a team"] },
    { entryId: "skills:a", kind: "skill", heading: "Skills", bullets: ["Planning and reporting"],
      skillItems: ["Planning", "Reporting"] },
    { entryId: "interest:a", kind: "interest", heading: "Interests", bullets: ["Volunteering"] },
  ],
};

function markup(result: CvContent, sourceTargeting?: CvTargetingView | null, resultTargeting?: CvTargetingView | null) {
  return renderToStaticMarkup(<CvEditionComparison source={source} result={result} sourceLabel="Auto source"
    sourceTargeting={sourceTargeting} resultTargeting={resultTargeting} />);
}

function view(priorities: Array<{ id: string; text: string; essential: boolean }>,
  treatments: Record<string, "feature" | "summarise" | "omit">): CvTargetingView {
  return { draftId: "draft", revision: 1, status: "confirmed",
    source: { libraryVersion: 1, evidenceHash: "a".repeat(64), jobDescriptionHash: "b".repeat(64) },
    essentialOmissionIds: [], acknowledgedEssentialOmissionIds: [], summaryNeedsReview: false,
    presentation: { maxPages: 2, bodySizePt: 12 },
    priorities: priorities.map((row, index) => ({ ...row, label: row.text, rank: index + 1, origin: "role", customised: false,
    selected: true, evidenceEntryIds: [], quote: row.text, importance: row.essential ? "essential" : "desirable",
    category: "experience" })),
    entries: Object.entries(treatments).map(([entryId, treatment]) => ({ entryId, kind: "experience", heading: entryId, treatment })) } as CvTargetingView;
}

it("shows moved, added and removed sections and the order of individual skills", () => {
  const result: CvContent = { ...source, sections: [
    { ...source.sections[1]! },
    { ...source.sections[0]! },
    { ...source.sections[2]!, skillItems: ["Reporting", "Planning"] },
    { entryId: "role:c", kind: "experience", heading: "Company C · Lead", bullets: ["Built a service"] },
  ] };
  const html = markup(result);
  expect(html).toContain("Removed: Interests");
  expect(html).toContain("Added: Company C · Lead");
  expect(html).toContain("Moved: Company A · Director");
  expect(html).toContain("Moved: Company B · Manager");
  expect(html).toMatch(/Planning<\/li><li>Reporting/);
  expect(html).toMatch(/Reporting<\/li><li>Planning/);
  expect(html).not.toContain("The saved sections and their order match this source.");
});

it("shows changed ranked priorities, Essential status, treatments, signposts and actual layout fields", () => {
  const before = view([{ id: "a", text: "Operational delivery", essential: true },
    { id: "b", text: "People leadership", essential: false }], { "role:a": "feature", "role:b": "feature" });
  const after = view([{ id: "b", text: "People leadership", essential: true },
    { id: "a", text: "Operational delivery", essential: false }], { "role:a": "summarise", "role:b": "feature" });
  const result: CvContent = { ...source, theme: { ...DEFAULT_CV_THEME, font: "Arial", bodySizePt: 12,
    maxPages: 2, primary: "#123456", background: "#fafafa", surface: "#eeeeee", pill: "#dddddd",
    introPanel: false, skillPills: false }, sections: source.sections.map(section => section.entryId === "role:a"
    ? { ...section, bulletSignposts: ["Impact", "Speed"] } : section) };
  const html = markup(result, before, after);
  expect(html).toContain("Role priorities changed");
  expect(html).toContain("People leadership · Essential");
  expect(html).toContain("Evidence treatment changed");
  expect(html).toContain("role:a: feature → summarise");
  expect(html).toContain("Delivery: Improved delivery");
  expect(html).toContain("Impact: Improved delivery");
  for (const label of ["Font", "Body size", "Page limit", "Primary colour", "Background colour",
    "Panel colour", "Pill colour", "Summary panel", "Skill pills"]) expect(html).toContain(`${label}:`);
});

it("does not claim historical priorities or treatments are unchanged when the source view is unavailable", () => {
  const after = view([{ id: "a", text: "New user priority", essential: true }], { "role:a": "omit" });
  const html = markup(source, null, after);
  expect(html).toMatch(/historical (priorit|evidence)|source (priorit|evidence).*unavailable|cannot compare/i);
  expect(html).not.toContain("Role priorities unchanged");
  expect(html).not.toContain("Evidence treatment unchanged");
});
