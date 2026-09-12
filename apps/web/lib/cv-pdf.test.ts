import { expect, it } from "vitest";
import { renderCvPdf } from "./cv-pdf";
it("renders an actual PDF from stored content without requiring a browser", async () => {
  const pdf = await renderCvPdf({ name: "Test Candidate", contact: "London · candidate@example.test", summary: "Operations and finance leader.",
    sections: [{ entryId: "one", kind: "experience", heading: "Director · Acme · 2020-2025", industryDescriptions: ["Healthcare", "SaaS"], bullets: ["Managed a £10m budget and a team of 30."] }], gaps: ["Missing evidence should not be printed"] });
  expect(pdf.subarray(0, 8).toString()).toContain("%PDF-1.");
  expect(pdf.subarray(-30).toString()).toContain("%%EOF");
});

// Observe drawing calls while still producing real PDFs: the old smoke test only
// checked the file signature, so an entirely unstyled PDF passed.
import PDFDocument from "pdfkit";
import { afterEach, vi } from "vitest";
import { CV_THEMES, DEFAULT_CV_THEME, type CvContent } from "@christopher/core/cv";
import { renderCvPdfWithReport } from "./cv-pdf";
const fixture: CvContent = { name: "Example Candidate", contact: "London", summary: "Operations leader.", sections: [
  { entryId: "skill", kind: "skill", heading: "Internal evidence label", bullets: ["Planning and reporting."] },
  { entryId: "degree", kind: "education", heading: "BSc Economics · Example University", bullets: ["BSc Economics, Example University. Distinction."] },
  { entryId: "extra", kind: "education", heading: "Project qualification", bullets: ["Completed practical training."] },
], gaps: [] };
afterEach(() => vi.restoreAllMocks());
it("renders the advertised Navy design for saved content without a theme", async () => {
  const fill = vi.spyOn(PDFDocument.prototype, "fill");
  const rounded = vi.spyOn(PDFDocument.prototype, "roundedRect");
  await renderCvPdf(fixture);
  expect(fill.mock.calls.some(call => call[0] === DEFAULT_CV_THEME.primary)).toBe(true);
  expect(rounded).toHaveBeenCalled();
  expect(fixture.theme).toBeUndefined();
});
it("honours an explicit palette and disabled profile card", async () => {
  const fill = vi.spyOn(PDFDocument.prototype, "fill");
  const rounded = vi.spyOn(PDFDocument.prototype, "roundedRect");
  await renderCvPdf({ ...fixture, theme: { ...CV_THEMES.Gold!, introPanel: false, skillPills: false } });
  expect(fill.mock.calls.some(call => call[0] === CV_THEMES.Gold!.primary)).toBe(true);
  expect(rounded).not.toHaveBeenCalled();
});
it("removes repeated skill and qualification labels without losing distinct evidence", async () => {
  const draw = vi.spyOn(PDFDocument.prototype, "text");
  await renderCvPdf(fixture);
  const labels = draw.mock.calls.map(call => call[0]);
  expect(labels).not.toContain("Skill");
  expect(labels).not.toContain("Internal evidence label");
  expect(labels).not.toContain("BSc Economics · Example University");
  expect(labels).toContain("BSc Economics, Example University. Distinction.");
  expect(labels).toContain("Project qualification");
  expect(labels).toContain("Completed practical training.");
});
it("labels continued jobs even when the saved draft has no theme", async () => {
  const draw = vi.spyOn(PDFDocument.prototype, "text");
  const { pageCount } = await renderCvPdfWithReport({ ...fixture, sections: [{ entryId: "job", kind: "experience", heading: "Director · Example", bullets: Array.from({ length: 6 }, () => "Managed operational planning and reporting. ".repeat(14)) }] });
  expect(pageCount).toBeGreaterThan(1);
  expect(draw.mock.calls.some(call => call[0] === "Director · Example (continued)")).toBe(true);
});
it("groups Education and Skills beneath one parent heading and retains legacy pills", async () => {
  const draw = vi.spyOn(PDFDocument.prototype, "text");
  const rounded = vi.spyOn(PDFDocument.prototype, "roundedRect");
  await renderCvPdf(fixture);
  const labels = draw.mock.calls.map(call => call[0]);
  expect(labels).toContain("Education");
  expect(labels).toContain("Skills");
  expect(labels.filter(label => label === "EDUCATION AND SKILLS")).toHaveLength(1);
  expect(labels.indexOf("EDUCATION AND SKILLS")).toBeLessThan(labels.indexOf("Skills"));
  expect(labels.indexOf("Skills")).toBeLessThan(labels.indexOf("Education"));
  expect(rounded.mock.calls.length).toBeGreaterThan(1);
});
it("rejects downloads above two pages while allowing a complete diagnostic preview", async () => {
  const long = { ...fixture, sections: Array.from({ length: 12 }, (_, i) => ({ entryId: String(i), kind: "experience" as const, heading: `Director ${i}`, bullets: Array.from({ length: 6 }, () => "Managed operational planning and reporting. ".repeat(12)) })) };
  expect((await renderCvPdfWithReport(long)).pageCount).toBeGreaterThan(2);
  await expect(renderCvPdf(long)).rejects.toThrow("the maximum is 2");
});
it("renders company industries as separate callout pills even when skill pills are disabled", async () => {
  const draw = vi.spyOn(PDFDocument.prototype, "text");
  const rounded = vi.spyOn(PDFDocument.prototype, "roundedRect");
  await renderCvPdf({ ...fixture, theme: { ...DEFAULT_CV_THEME, introPanel: false, skillPills: false }, sections: [{ entryId: "job", kind: "experience", heading: "Director · Example", industryDescriptions: ["Healthcare", "Software & SaaS"], bullets: ["Led a team."] }] });
  expect(rounded).toHaveBeenCalledTimes(2);
  expect(draw.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining(["Healthcare", "Software & SaaS"]));
  expect(draw.mock.calls.map(call => call[0])).not.toContain("Healthcare · Software & SaaS");
});

it("centres wrapped skill and industry text inside its pill bounds", async () => {
  const draw = vi.spyOn(PDFDocument.prototype, "text");
  const rounded = vi.spyOn(PDFDocument.prototype, "roundedRect");
  const long = "W".repeat(110);
  await renderCvPdf({ ...fixture, theme: { ...DEFAULT_CV_THEME, introPanel: false }, sections: [
    { entryId: "job", kind: "experience", heading: "Director", industryDescriptions: [long], bullets: ["Led a team."] },
    { entryId: "skill", kind: "skill", heading: "Skills", bullets: [long] },
  ] });
  const labels = draw.mock.calls.filter(call => call[0] === long.trim());
  expect(labels).toHaveLength(2);
  for (let i = 0; i < labels.length; i++) {
    const [, x, y, options] = labels[i]!;
    const [pillX, pillY, pillWidth, pillHeight] = rounded.mock.calls[i]! as [number, number, number, number, number];
    expect(options).toMatchObject({ align: "center", baseline: "middle" });
    const padding = i === 0 ? 8 : 10;
    expect(x).toBe(pillX! + padding);
    expect((options as { width: number }).width).toBeCloseTo(pillWidth! - padding * 2);
    const measure = new PDFDocument();
    measure.font("Helvetica").fontSize(i === 0 ? 8 : 9);
    const textHeight = measure.heightOfString(long.trim(), { width: pillWidth! - padding * 2, lineGap: 1 });
    expect(y).toBeCloseTo(pillY! + (pillHeight! - textHeight + measure.currentLineHeight(true) + 1) / 2);
    measure.end();
  }
});

it("validates content limits at the shared renderer boundary", async () => {
  await expect(renderCvPdf({ ...fixture, sections: [{ ...fixture.sections[0]!, bullets: ["x".repeat(651)] }] })).rejects.toThrow();
  await expect(renderCvPdf({ ...fixture, sections: [{ ...fixture.sections[0]!, bullets: Array(7).fill("Skill") }] })).rejects.toThrow();
  await expect(renderCvPdf({ ...fixture, sections: [{ ...fixture.sections[1]!, skillItems: ["SQL"] }] })).rejects.toThrow("Individual skills belong to skill sections only");
});
