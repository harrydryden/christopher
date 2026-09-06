import { expect, it } from "vitest";
import { renderCvPdf } from "./cv-pdf";
it("renders an actual PDF from stored content without requiring a browser", async () => {
  const pdf = await renderCvPdf({ name: "Test Candidate", contact: "London · candidate@example.test", summary: "Operations and finance leader.",
    sections: [{ entryId: "one", kind: "experience", heading: "Director · Acme · 2020-2025", bullets: ["Managed a £10m budget and a team of 30."] }], gaps: ["Missing evidence should not be printed"] });
  expect(pdf.subarray(0, 8).toString()).toContain("%PDF-1.");
  expect(pdf.subarray(-30).toString()).toContain("%%EOF");
});
