import { expect, it } from "vitest";
import { CvContentSchema, DEFAULT_CV_THEME } from "./cv";
import { cvPdfBodyMetrics, measureCvPdf, renderCvPdfWithReport } from "./cv-pdf";

it.each(["Arial", DEFAULT_CV_THEME.font] as const)("measurement preserves export geometry with %s", async font => {
  for (const bodySizePt of [11, 12]) {
    const content = CvContentSchema.parse({ name: "Synthetic Candidate", contact: "London",
      summary: "Operations leader.", theme: { ...DEFAULT_CV_THEME, font, bodySizePt, maxPages: 1 },
      sections: Array.from({ length: 8 }, (_, i) => ({ entryId: `role${i}`, kind: "experience",
        heading: `Company ${i} · Operations lead · 2020–2025`,
        bullets: Array.from({ length: 5 }, () => "Led operational improvements across distributed teams, reducing delivery time by 20%."),
        industryDescriptions: ["Software"] })), gaps: [] });
    const exported = await renderCvPdfWithReport(content);
    const measured = await measureCvPdf(content);
    expect(measured).toEqual({ pageCount: exported.pageCount, maxPages: exported.maxPages, layout: exported.layout });
    expect(measured.pageCount).toBeGreaterThan(measured.maxPages);
    expect(measured).not.toHaveProperty("pdf");
    expect(exported.pdf.subarray(0, 4).toString()).toBe("%PDF");
  }
});

it("keeps cached geometry isolated by font and size, with no shared mutable result", () => {
  const small = { ...DEFAULT_CV_THEME, font: "Arial" as const, bodySizePt: 11 as const };
  const large = { ...small, bodySizePt: 12 as const };
  const original = cvPdfBodyMetrics(small);
  const expected = { ...original };
  original.charactersPerLine = 0;
  expect(cvPdfBodyMetrics(small)).toEqual(expected);
  expect(cvPdfBodyMetrics(large).charactersPerLine).toBeLessThan(expected.charactersPerLine);
  expect(cvPdfBodyMetrics({ ...small, font: "Course of Life" }).representativeCharacterWidthPt)
    .not.toBe(expected.representativeCharacterWidthPt);
});
