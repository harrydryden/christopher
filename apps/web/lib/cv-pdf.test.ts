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
import { CV_THEMES, DEFAULT_CV_THEME, type CvContent } from "@ava/core/cv";
import { renderCvPdfWithReport } from "./cv-pdf";
const fixture: CvContent = { name: "Example Candidate", contact: "London", summary: "Operations leader.", sections: [
  { entryId: "skill", kind: "skill", heading: "Internal evidence label", bullets: ["Planning and reporting."] },
  { entryId: "degree", kind: "education", heading: "BSc Economics · Example University", bullets: ["BSc Economics, Example University. Distinction."] },
  { entryId: "extra", kind: "education", heading: "Project qualification", bullets: ["Completed practical training."] },
], gaps: [] };
afterEach(() => vi.restoreAllMocks());
it("renders the advertised Black design for saved content without a theme", async () => {
  const fill = vi.spyOn(PDFDocument.prototype, "fill");
  const rounded = vi.spyOn(PDFDocument.prototype, "roundedRect");
  await renderCvPdf(fixture);
  expect(fill.mock.calls.some((call) => call[0] === DEFAULT_CV_THEME.primary)).toBe(true);
  expect(rounded).toHaveBeenCalled();
  expect(fixture.theme).toBeUndefined();
});
it("honours an explicit palette and disabled profile card", async () => {
  const fill = vi.spyOn(PDFDocument.prototype, "fill");
  const rounded = vi.spyOn(PDFDocument.prototype, "roundedRect");
  await renderCvPdf({ ...fixture, theme: { ...CV_THEMES.Gold!, introPanel: false, skillPills: false } });
  expect(fill.mock.calls.some((call) => call[0] === CV_THEMES.Gold!.primary)).toBe(true);
  // The profile card is optional; legacy false skillPills flags cannot disable required skill pills.
  expect(rounded).toHaveBeenCalled();
});
it("shows distinct skill headings and removes repeated qualification labels", async () => {
  const draw = vi.spyOn(PDFDocument.prototype, "text");
  await renderCvPdf(fixture);
  const labels = draw.mock.calls.map((call) => call[0]);
  expect(labels).not.toContain("Skill");
  expect(labels).toContain("Internal evidence label");
  expect(labels).not.toContain("BSc Economics · Example University");
  expect(labels).toContain("BSc Economics, Example University. Distinction.");
  expect(labels).toContain("Project qualification");
  expect(labels).toContain("Completed practical training.");
});
it("labels continued jobs even when the saved draft has no theme", async () => {
  const draw = vi.spyOn(PDFDocument.prototype, "text");
  const { pageCount } = await renderCvPdfWithReport({ ...fixture, sections: [{ entryId: "job", kind: "experience", heading: "Director · Example", bullets: Array.from({ length: 6 }, () => "Managed operational planning and reporting. ".repeat(14)) }] });
  expect(pageCount).toBeGreaterThan(1);
  expect(draw.mock.calls.some(
      (call) => call[0] === "Director · Example (continued)")).toBe(true);
});
it("groups Education and Skills beneath one parent heading and retains legacy pills", async () => {
  const draw = vi.spyOn(PDFDocument.prototype, "text");
  const rounded = vi.spyOn(PDFDocument.prototype, "roundedRect");
  await renderCvPdf(fixture);
  const labels = draw.mock.calls.map((call) => call[0]);
  expect(labels).toContain("Education");
  expect(labels).toContain("Skills");
  expect(labels).toContain("Internal evidence label");
  expect(labels.filter((label) => label === "EDUCATION AND SKILLS")).toHaveLength(1);
  expect(labels.indexOf("EDUCATION AND SKILLS")).toBeLessThan(labels.indexOf("Skills"));
  expect(labels.indexOf("Skills")).toBeLessThan(labels.indexOf("Internal evidence label"));
  expect(labels.indexOf("Internal evidence label")).toBeLessThan(labels.indexOf("Education"));
  expect(rounded.mock.calls.length).toBeGreaterThan(1);
});
it("places each bold section pill first in its full-width skill group", async () => {
  const draw = vi.spyOn(PDFDocument.prototype, "text");
  const rounded = vi.spyOn(PDFDocument.prototype, "roundedRect");
  const headings = ["Operations and commercial leadership", "Technology, systems and data transformation across regional operating units with complex reporting obligations"];
  const report = await renderCvPdfWithReport({
    ...fixture,
    theme: { ...DEFAULT_CV_THEME, introPanel: false },
    sections: headings.map((heading, index) => ({
      entryId: `skills-${index}`, kind: "skill" as const, heading,
      skillItems: Array.from({ length: 10 }, (_, skill) => `${heading} capability ${skill + 1}`),
      bullets: [heading],
    })),
  });
  expect(report.pageCount).toBe(1);
  const labelCalls = headings.map(heading => draw.mock.calls.find(call => call[0] === heading)!);
  expect(labelCalls.every(call => call)).toBe(true);
  expect(labelCalls.map(call => Number(call[1]))).toEqual([50, 50]);
  const pageWidth = 595.28 - 88;
  expect(labelCalls.every(call => (call[3] as { width: number }).width <= pageWidth - 12)).toBe(true);
  const skillPills = rounded.mock.calls;
  expect(skillPills).toHaveLength(22);
  expect(Number(skillPills[0]![0])).toBe(44);
  expect(Number(skillPills[11]![0])).toBe(44);
  expect(skillPills.every(call => Number(call[0]) + Number(call[2]) <= 44 + pageWidth + 0.01)).toBe(true);
  expect(Number(skillPills[0]![1])).toBeLessThan(Number(labelCalls[0]![2]));
  expect(Number(skillPills[11]![1])).toBeLessThan(Number(labelCalls[1]![2]));
  expect(Number(labelCalls[1]![2])).toBeGreaterThan(Number(skillPills[9]![1]));
  expect(draw.mock.calls.map(call => call[0]).filter(label => label === "Skills")).toHaveLength(1);
});
it("repeats the section pill when an oversized block continues on another page", async () => {
  const draw = vi.spyOn(PDFDocument.prototype, "text");
  const heading = "Long technology and data transformation heading";
  const label = "W".repeat(145);
  const report = await renderCvPdfWithReport({
    ...fixture,
    sections: [{ entryId: "skills", kind: "skill", heading,
      skillItems: Array.from({ length: 20 }, (_, index) => `${label} ${index + 1}`), bullets: [label] }],
  });
  expect(report.pageCount).toBeGreaterThan(1);
  const continued = draw.mock.calls.find(call => call[0] === `${heading} (continued)`);
  expect(continued).toBeDefined();
  expect(Number(continued![1])).toBe(50);
  expect((continued![3] as { width: number }).width).toBeLessThanOrEqual(595.28 - 100);
  for (let index = 0; index < 20; index++) {
    expect(draw.mock.calls.filter(call => call[0] === `${label} ${index + 1}`)).toHaveLength(1);
  }
});
it("fits three skill sections of ten readable pills within half a page", async () => {
  const draw = vi.spyOn(PDFDocument.prototype, "text");
  const rounded = vi.spyOn(PDFDocument.prototype, "roundedRect");
  const groups = [
    { heading: "Leadership and commercial", items: [
      "Executive & board reporting", "Commercial leadership and RevOps", "Strategic planning",
      "Budget ownership", "Cross-functional leadership", "Operating model design",
      "Stakeholder management", "Sales forecasting", "Change management", "Team coaching",
    ] },
    { heading: "Data and insight", items: [
      "Data modelling and metric design", "SQL", "Python", "Power BI dashboards",
      "Customer segmentation", "Forecast modelling", "KPI architecture",
      "Experiment design", "Data storytelling", "Performance analysis",
    ] },
    { heading: "Delivery and systems", items: [
      "Programme delivery", "Process improvement", "CRM implementation",
      "Salesforce administration", "Workflow automation", "Vendor management",
      "Risk and issue management", "Service design", "Agile delivery", "Quality assurance",
    ] },
  ];
  const sections = groups.map(({ heading, items }, group) => ({
    entryId: `skills-${group}`, kind: "skill" as const, heading,
    skillItems: items, bullets: [items[0]!],
  }));
  const report = await renderCvPdfWithReport({
    ...fixture,
    theme: { ...DEFAULT_CV_THEME, introPanel: false },
    sections: [{ entryId: "generic", kind: "skill", heading: "Skills", skillItems: ["Planning"], bullets: ["Planning"] }, ...sections],
  });
  const labels = draw.mock.calls.map((call) => call[0]);
  expect(report.pageCount).toBe(1);
  expect(labels.filter((label) => label === "Skills")).toHaveLength(2);
  for (const section of sections) expect(labels).toContain(section.heading);
  const skillPills = rounded.mock.calls.filter((call) => call[2] !== undefined);
  expect(skillPills).toHaveLength(35);
  const parentHeading = draw.mock.calls.find((call) => call[0] === "EDUCATION AND SKILLS");
  expect(parentHeading).toBeDefined();
  const last = skillPills[skillPills.length - 1]!;
  expect(Number(last[1]) + Number(last[3]) - Number(parentHeading![2])).toBeLessThan(420);
});
it.each(["AVA", "Arial"] as const)("keeps the reported 18 skills compact and uniform in %s", async (font) => {
  const rounded = vi.spyOn(PDFDocument.prototype, "roundedRect");
  const draw = vi.spyOn(PDFDocument.prototype, "text");
  const groups = [
    { heading: "Operations", items: ["Financial Planning & Analysis", "P&L Management", "Unit Economics", "Product Operations", "Customer Success", "Customer Support"] },
    { heading: "Commercial", items: ["Commercial Strategy", "Expansion Strategy", "RevOps", "P&L Ownership", "Financial Modelling", "Investor Relations"] },
    { heading: "Technology tooling", items: ["SQL", "BI Tools", "CRM Platforms", "Sales Automation", "Agile Systems", "Advanced AI Coding"] },
  ];
  const result = await renderCvPdfWithReport({ ...fixture, theme: { ...DEFAULT_CV_THEME, font, introPanel: false },
    sections: groups.map(({ heading, items }, index) => ({ entryId: `s-${index}`, kind: "skill", heading, skillItems: items, bullets: [items[0]!] })) });
  expect(result.pageCount).toBe(1);
  expect(rounded.mock.calls).toHaveLength(21);
  const heights = rounded.mock.calls.map(call => Number(call[3]));
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(0.01);
  for (const [groupIndex, group] of groups.entries()) {
    const calls = rounded.mock.calls.slice(groupIndex * 7, groupIndex * 7 + 7);
    for (let index = 1; index < calls.length; index++) {
      const previous = calls[index - 1]!;
      const current = calls[index]!;
      if (Number(current[1]) !== Number(previous[1])) {
        // A wrap is allowed only when the next pill would exceed the content width.
        expect(Number(previous[0]) + Number(previous[2]) + 5 + Number(current[2])).toBeGreaterThan(595.28 - 44);
      }
    }
    for (const item of group.items) expect(draw.mock.calls.filter(call => call[0] === item)).toHaveLength(1);
  }
  const top = Number(draw.mock.calls.find(call => call[0] === "Operations")![2]);
  const last = rounded.mock.calls.at(-1)!;
  expect(Number(last[1]) + Number(last[3]) - top).toBeLessThan(200);
});
it("fits four sections of ten normal skills within half a page", async () => {
  const rounded = vi.spyOn(PDFDocument.prototype, "roundedRect");
  const draw = vi.spyOn(PDFDocument.prototype, "text");
  const items = ["Financial planning", "Operations strategy", "Customer success", "SQL", "BI Tools", "CRM Platforms", "Sales Automation", "Risk management", "Team leadership", "Board reporting"];
  const result = await renderCvPdfWithReport({ ...fixture, theme: { ...DEFAULT_CV_THEME, introPanel: false }, sections:
    ["Operations", "Commercial", "Technology", "Governance"].map((heading, index) => ({entryId: `s-${index}`, kind: "skill", heading, skillItems: items, bullets: [items[0]!] })) });
  expect(result.pageCount).toBe(1);
  expect(rounded.mock.calls).toHaveLength(44);
  const top = Number(draw.mock.calls.find(call => call[0] === "Operations")![2]);
  const last = rounded.mock.calls.at(-1)!;
  expect(Number(last[1]) + Number(last[3]) - top).toBeLessThan(420);
});
it("rejects downloads above the CV's own page limit while allowing a complete diagnostic preview", async () => {
  const long = { ...fixture, sections: Array.from({ length: 12 }, (_, i) => ({ entryId: String(i), kind: "experience" as const, heading: `Director ${i}`,
      bullets: Array.from({ length: 6 }, () =>
        "Managed operational planning and reporting. ".repeat(12),
      ),
    })),
  };
  const report = await renderCvPdfWithReport(long);
  expect(report.pageCount).toBeGreaterThan(3);
  expect(report.maxPages).toBe(3);
  await expect(renderCvPdf(long)).rejects.toThrow("the maximum is 3");
  const generous = { ...long, theme: { ...DEFAULT_CV_THEME, maxPages: 5 } };
  expect((await renderCvPdfWithReport(generous)).maxPages).toBe(5);
  await expect(renderCvPdf(generous)).rejects.toThrow("the maximum is 5");
  const trimmed = { ...long, sections: long.sections.slice(0, 3) };
  expect((await renderCvPdfWithReport(trimmed)).pageCount).toBe(3);
  await expect(renderCvPdf(trimmed)).resolves.toBeInstanceOf(Buffer);
  await expect(renderCvPdf({ ...trimmed, theme: { ...DEFAULT_CV_THEME, maxPages: 2 } })).rejects.toThrow("the maximum is 2");
});
it("embeds Liberation Sans for the Arial font and keeps the built-in face for AVA", async () => {
  const builtIn = (await renderCvPdf(fixture)).toString("latin1");
  expect(builtIn).toContain("/BaseFont /Helvetica");
  expect(builtIn).not.toContain("LiberationSans");
  const arial = (await renderCvPdf({ ...fixture, theme: { ...DEFAULT_CV_THEME, font: "Arial" } })).toString("latin1");
  expect(arial).toContain("LiberationSans");
  expect(arial).toContain("LiberationSans-Bold");
  expect(arial).not.toContain("/BaseFont /Helvetica");
  // Arial is metric-compatible with Helvetica, so the page limit measures the same either way.
  const long = { ...fixture, sections: [{ entryId: "job", kind: "experience" as const, heading: "Director · Example", bullets: Array.from({ length: 6 }, () => "Managed operational planning and reporting. ".repeat(14)) }] };
  expect((await renderCvPdfWithReport({ ...long, theme: { ...DEFAULT_CV_THEME, font: "Arial" } })).pageCount).toBe((await renderCvPdfWithReport(long)).pageCount);
});
it("renders company industries as separate callout pills even when skill pills are disabled", async () => {
  const draw = vi.spyOn(PDFDocument.prototype, "text");
  const rounded = vi.spyOn(PDFDocument.prototype, "roundedRect");
  await renderCvPdf({
    ...fixture,
    theme: { ...DEFAULT_CV_THEME, introPanel: false, skillPills: false },
    sections: [
      {
        entryId: "job",
        kind: "experience",
        heading: "Director · Example",
        industryDescriptions: ["Healthcare", "Software & SaaS"],
        bullets: ["Led a team."],
      },
    ],
  });
  expect(rounded).toHaveBeenCalledTimes(2);
  expect(draw.mock.calls.map((call) => call[0])).toEqual(
    expect.arrayContaining(["Healthcare", "Software & SaaS"]),
  );
  expect(draw.mock.calls.map((call) => call[0])).not.toContain(
    "Healthcare · Software & SaaS",
  );
});

it("centres wrapped skill and industry text inside its pill bounds", async () => {
  const draw = vi.spyOn(PDFDocument.prototype, "text");
  const rounded = vi.spyOn(PDFDocument.prototype, "roundedRect");
  const long = "W".repeat(110);
  await renderCvPdf({
    ...fixture,
    theme: { ...DEFAULT_CV_THEME, introPanel: false },
    sections: [
      {
        entryId: "job",
        kind: "experience",
        heading: "Director",
        industryDescriptions: [long],
        bullets: ["Led a team."],
      },
      { entryId: "skill", kind: "skill", heading: "Skills", bullets: [long] },
    ],
  });
  const labels = draw.mock.calls.filter((call) => call[0] === long.trim());
  expect(labels).toHaveLength(2);
  for (let i = 0; i < labels.length; i++) {
    const [, x, y, options] = labels[i]!;
    const [pillX, pillY, pillWidth, pillHeight] = rounded.mock.calls[i === 0 ? 0 : 2]! as [
      number,
      number,
      number,
      number,
      number,
    ];
    expect(options).toMatchObject({ align: "center", baseline: "middle" });
    const padding = i === 0 ? 8 : 6;
    expect(x).toBe(pillX! + padding);
    expect((options as { width: number }).width).toBeCloseTo(
      pillWidth! - padding * 2,
    );
    const measure = new PDFDocument();
    measure.font("Helvetica").fontSize(i === 0 ? 8 : 8.5);
    const textHeight = measure.heightOfString(long.trim(), {
      width: pillWidth! - padding * 2,
      lineGap: 1,
    });
    expect(y).toBeCloseTo(
      pillY! +
        (pillHeight! - textHeight + measure.currentLineHeight(true) + 1) / 2,
    );
    measure.end();
  }
});

it("validates content limits at the shared renderer boundary", async () => {
  await expect(
    renderCvPdf({
      ...fixture,
      sections: [{ ...fixture.sections[0]!, bullets: ["x".repeat(651)] }],
    }),
  ).rejects.toThrow();
  await expect(
    renderCvPdf({
      ...fixture,
      sections: [{ ...fixture.sections[0]!, bullets: Array(7).fill("Skill") }],
    }),
  ).rejects.toThrow();
  await expect(
    renderCvPdf({
      ...fixture,
      sections: [{ ...fixture.sections[1]!, skillItems: ["SQL"] }],
    }),
  ).rejects.toThrow("Individual skills belong to skill sections only");
});

it("renders both profile and website links as separate PDF annotations", async () => {
  const linkedinUrl = "https://www.linkedin.com/in/example";
  const websiteUrl = "https://example.com/portfolio";
  const pdf = await renderCvPdf({ name: "Example", contact: "London", linkedinUrl, websiteUrl, summary: "Operations leader", sections: [{ entryId: "s", kind: "skill", heading: "Skills", bullets: ["Operations"] }], gaps: [] });
  const raw = pdf.toString("latin1");
  expect(raw).toContain(`/URI (${linkedinUrl})`);
  expect(raw).toContain(`/URI (${websiteUrl})`);
});
it.each(["AVA", "Arial"] as const)("flows an experience across pages instead of leaving a large gap in %s", async font => {
  const draw = vi.spyOn(PDFDocument.prototype, "text");
  const pages = vi.spyOn(PDFDocument.prototype, "addPage");
  const first = Array.from({ length: 5 }, (_, i) => `First achievement ${i + 1}: ${"Led planning, reporting and delivery across regional teams. ".repeat(5)}`);
  const second = Array.from({ length: 6 }, (_, i) => `Second achievement ${i + 1}: ${"Built operating plans and improved customer services across international businesses. ".repeat(5)}`);
  await renderCvPdfWithReport({ ...fixture, theme: { ...DEFAULT_CV_THEME, font }, sections: [
    {entryId: "first", kind: "experience", heading: "Director · First company", bullets: first},
    {entryId: "second", kind: "experience", heading: "Manager · Second company", bullets: second},
  ] });
  const pageFor = (label: string) => {
    const index = draw.mock.calls.findIndex(call => call[0] === label.trim());
    expect(index).toBeGreaterThanOrEqual(0);
    return pages.mock.invocationCallOrder.filter(order => order < draw.mock.invocationCallOrder[index]!).length;
  };
  expect(pageFor("Manager · Second company")).toBe(pageFor(first[0]!));
  expect(pageFor(second[0]!)).toBe(pageFor("Manager · Second company"));
  expect(pageFor(second.at(-1)!)).toBeGreaterThan(pageFor(second[0]!));
  expect(draw.mock.calls.some(call => call[0] === "Manager · Second company (continued)")).toBe(true);
  for (const bullet of [...first, ...second]) expect(draw.mock.calls.filter(call => call[0] === bullet.trim())).toHaveLength(1);
});
it("keeps an experience intact when only a small gap remains", async () => {
  const draw = vi.spyOn(PDFDocument.prototype, "text");
  const pages = vi.spyOn(PDFDocument.prototype, "addPage");
  const first = Array.from({length:6}, (_, i) => `First achievement ${i + 1}: ${"Led planning, reporting and delivery across regional teams. ".repeat(8)}`);
  const second = Array.from({length:3}, (_, i) => `Second achievement ${i + 1}: ${"Built operating plans and improved customer services. ".repeat(4)}`);
  await renderCvPdfWithReport({...fixture, sections:[
    {entryId:"first", kind:"experience", heading:"Director · First company", bullets:first},
    {entryId:"second", kind:"experience", heading:"Manager · Second company", bullets:second},
  ]});
  const pageFor = (label: string) => {
    const index = draw.mock.calls.findIndex(call => call[0] === label.trim());
    expect(index).toBeGreaterThanOrEqual(0);
    return pages.mock.invocationCallOrder.filter(order => order < draw.mock.invocationCallOrder[index]!).length;
  };
  expect(pageFor(first.at(-1)!)).toBe(pageFor(first[0]!));
  expect(pageFor("Manager · Second company")).toBe(pageFor(first[0]!) + 1);
  expect(pageFor(second[0]!)).toBe(pageFor("Manager · Second company"));
  expect(pageFor(second.at(-1)!)).toBe(pageFor(second[0]!));
  expect(draw.mock.calls.some(call => call[0] === "Manager · Second company (continued)")).toBe(false);
});
