import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CvNextAction } from "@/components/CvNextAction";
import { cvNextAction } from "./cv-next-action";

const ready = {
  status: "ready" as const, finalised: false, hasContent: true, assessmentCurrent: true,
  factualConcerns: 0, finaliseReason: null, improving: false, libraryChanged: false,
};

it("names the next action as a CV moves through build, evidence, assessment and finalisation", () => {
  expect(cvNextAction({ ...ready, status: "generating", hasContent: false }).title).toBe("Building your CV");
  expect(cvNextAction({ ...ready, status: "awaiting_evidence" }).title).toBe("Answer or skip the evidence questions");
  expect(cvNextAction({ ...ready, assessmentCurrent: false }).title).toBe("Check this CV");
  expect(cvNextAction({ ...ready, factualConcerns: 2 }).detail).toContain("2 factual concerns");
  expect(cvNextAction({ ...ready, finaliseReason: "The PDF is over one page." }).detail).toContain("over one page");
  expect(cvNextAction(ready).title).toBe("Review and finalise this CV");
  expect(cvNextAction({ ...ready, finalised: true, hasFinalPdf: true }).title).toBe("Download your final CV");
  expect(cvNextAction({ ...ready, finalised: true, hasFinalPdf: false }).title).toBe("Create a new revision");
});

it("says what to do when the Library moves on or a stronger revision is still running", () => {
  expect(cvNextAction({ ...ready, libraryChanged: true }).detail).toContain("Experience has changed");
  expect(cvNextAction({ ...ready, improving: true }).detail).toContain("background");
});

it("offers a direct link to the relevant CV tab or the final PDF", () => {
  const id = "draft-1";
  const assessment = renderToStaticMarkup(createElement(CvNextAction, { id, next: cvNextAction(ready) }));
  expect(assessment).toContain('href="#cv-panel-evaluation"');
  expect(assessment).toContain("Open Review");
  const questions = renderToStaticMarkup(createElement(CvNextAction, { id, next: cvNextAction({ ...ready, status: "awaiting_evidence" }) }));
  expect(questions).toContain('href="#cv-panel-content"');
  const final = renderToStaticMarkup(createElement(CvNextAction, { id, next: cvNextAction({ ...ready, finalised: true, hasFinalPdf: true }) }));
  expect(final).toContain('href="/api/cv/draft-1/pdf"');
});
