import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prerenderToNodeStream } from "react-dom/static";
import { expect, it, vi } from "vitest";
import { createCvAssessment } from "@ava/core/cv-review";
import { materialiseCv, type CvLibrary } from "@ava/core/cv";
import {
  cvTextItems,
  cvClaimItems,
  cvEvidenceItems,
} from "@ava/core/cv-assessment";
import {
  rubricFixture,
  reviewFixture,
} from "../../../packages/core/test/cv-review-fixture";
// Next resolves `next/dynamic` to its app-router implementation for app/ code; outside Next the
// package entry is the pages-router one, which never renders the component on the server.
vi.mock("next/dynamic", async () => {
  const appDynamic = (await import("next/dist/shared/lib/app-dynamic")) as { default: unknown };
  const dynamic = appDynamic.default as { default?: unknown };
  return { default: dynamic.default ?? dynamic };
});
vi.mock("@/app/actions/cv", () => ({
  assessCvDraft: vi.fn(),
  finaliseCvDraft: vi.fn(),
}));
import { CvAssessmentPanel } from "@/components/CvAssessmentPanel";

/**
 * The panel as the server sends it, with the evaluation table in it. The table is its own chunk
 * (components/CvLazyWidgets.tsx), which a server render waits for; `renderToStaticMarkup` cannot,
 * so it would show only the loading fallback in the table's place.
 */
async function renderSettled(element: Parameters<typeof renderToStaticMarkup>[0]): Promise<string> {
  const { prelude } = await prerenderToNodeStream(element);
  let html = "";
  for await (const chunk of prelude) html += String(chunk);
  return html;
}
const library: CvLibrary = {
  name: "Example",
  contact: "",
  profile: "Analyst",
  entries: [
    {
      id: "e",
      kind: "experience",
      heading: "Analyst",
      details: "Assisted reporting",
      confirmedResponsibilities: ["Assisted reporting"],
    },
  ],
};
const content = materialiseCv(library, {
  summary: "Analyst",
  sections: [{ entryId: "e", bullets: ["Owned a £10m budget"] }],
  gaps: [],
});
it("shows evidence questions and actual unsupported wording, with no finalisation control", async () => {
  const description = "Own a budget";
  const rubric = rubricFixture(description);
  const review = reviewFixture({
    rubric,
    cv: cvTextItems(content),
    claims: cvClaimItems(content),
    evidence: cvEvidenceItems(library),
  });
  Object.assign(review.matches[0]!, {
    status: "missing",
    libraryStatus: "unknown",
    cvEvidence: [],
    libraryEvidence: [],
    improvement: "Provide your actual budget ownership and scope.",
  });
  Object.assign(review.claims[1]!, {
    status: "unsupported",
    evidence: [],
    reason: "The evidence only says assisted reporting.",
  });
  const assessment = createCvAssessment({
    content,
    description,
    library,
    rubric,
    review,
    model: "test",
    pageCount: 1,
  });
  const html = await renderSettled(
    createElement(CvAssessmentPanel, {
      id: "test",
      assessment,
      current: true,
      finalised: false,
      busy: false,
      hasContent: true,
      content,
    }),
  );
  expect(html).toContain("0/100");
  expect(html).toContain("Quality checks");
  expect(html).toContain("Factual support");
  expect(html).toContain("Priority coverage");
  expect(html).toContain("Evidence ready to use");
  expect(html).toContain("Logistics to confirm");
  expect(html).toContain("Heuristic editorial signals only");
  expect(html).toContain("Provide your actual budget ownership and scope.");
  expect(html).toContain("Owned a £10m budget");
  expect(html).not.toContain("claim: section:");
  expect(html).not.toContain("Finalise this CV");
  expect(html).not.toContain("Your input needed");
  expect(html).toContain("<em>Owned a £10m budget</em>");
  expect(html).toContain("Item");
  expect(html).not.toContain("<blockquote");
  expect(html).not.toContain("<details");
});
it("never displays a stale score as a current assessment", () => {
  const html = renderToStaticMarkup(
    createElement(CvAssessmentPanel, {
      id: "test",
      assessment: null,
      current: false,
      finalised: false,
      busy: false,
      hasContent: true,
      content,
    }),
  );
  expect(html).toContain("Fit and assess saved revision");
  expect(html).not.toContain("/100");
});

it("retains finalisation for supported current assessments only", () => {
  const description = "Own a budget";
  const rubric = rubricFixture(description);
  const review = reviewFixture({
    rubric,
    cv: cvTextItems(content),
    claims: cvClaimItems(content),
    evidence: cvEvidenceItems(library),
  });
  const assessment = createCvAssessment({
    content,
    description,
    library,
    rubric,
    review,
    model: "test",
    pageCount: 2,
  });
  const render = (current: boolean, busy: boolean, pageCount = 2) =>
    renderToStaticMarkup(
      createElement(CvAssessmentPanel, {
        id: "test",
        assessment: { ...assessment, pageCount },
        current,
        finalised: false,
        busy,
        hasContent: true,
        content,
      }),
    );
  expect(render(true, false)).toContain("Finalise this CV");
  expect(render(false, false)).not.toContain("Finalise this CV");
  expect(render(true, true)).not.toContain("Finalise this CV");
  // The default limit is three pages; a CV whose theme allows two is gated at two.
  expect(render(true, false, 3)).toContain("Finalise this CV");
  expect(render(true, false, 4)).not.toContain("Finalise this CV");
});

it("says why finalising is unavailable instead of hiding the control", () => {
  const description = "Own a budget";
  const rubric = rubricFixture(description);
  const review = reviewFixture({
    rubric,
    cv: cvTextItems(content),
    claims: cvClaimItems(content),
    evidence: cvEvidenceItems(library),
  });
  const assessment = createCvAssessment({
    content,
    description,
    library,
    rubric,
    review,
    model: "test",
    pageCount: 4,
  });
  // The page computes the sentence with `assertCvFinalisable` and passes it in; the panel prints
  // it rather than leaving an absent button to be interpreted.
  const overPages = renderToStaticMarkup(
    createElement(CvAssessmentPanel, {
      id: "test",
      assessment,
      current: true,
      finalised: false,
      busy: false,
      hasContent: true,
      content,
      finaliseReason: "Fit this CV to 3 pages before finalising it.",
    }),
  );
  expect(overPages).toContain("Finalise is not available yet: Fit this CV to 3 pages before finalising it.");
  expect(overPages).toContain("This revision measures 4 pages");
  expect(overPages).not.toContain("Finalise this CV");

  // A stale assessment reaches the panel before any table does: the same sentence, beside the
  // control that clears it.
  const stale = renderToStaticMarkup(
    createElement(CvAssessmentPanel, {
      id: "test",
      assessment: null,
      current: false,
      finalised: false,
      busy: false,
      hasContent: true,
      content,
      finaliseReason: "Assess this saved revision against the job description before finalising it.",
    }),
  );
  expect(stale).toContain("Assess this saved revision against the job description before finalising it.");
  expect(stale).toContain("Fit and assess saved revision");
});

it("disables the actions that spend money until the address is confirmed, and says why", () => {
  const sentence = "Confirm your email address to add companies, run discovery and build CVs.";
  const html = renderToStaticMarkup(
    createElement(CvAssessmentPanel, {
      id: "test",
      assessment: null,
      current: false,
      finalised: false,
      busy: false,
      hasContent: true,
      content,
      blocked: sentence,
    }),
  );
  expect(html).toContain(sentence);
  expect(html).toMatch(/<fieldset disabled=""[\s\S]*Fit and assess saved revision/);
});
