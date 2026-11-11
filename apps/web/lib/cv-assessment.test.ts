import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prerenderToNodeStream } from "react-dom/static";
import { expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { createCvAssessment } from "@col/core/cv-review";
import { materialiseCv, type CvLibrary } from "@col/core/cv";
import {
  cvTextItems,
  cvClaimItems,
  cvEvidenceItems,
} from "@col/core/cv-assessment";
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
vi.mock("@/app/actions/cv-finalisation", () => ({
  prepareCvFinalisation: vi.fn(), approveCvFinalisation: vi.fn(),
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
for (const [paused, label] of [["evidence", "evidence questions"], ["priorities", "priority choices"]] as const) {
  it(`keeps Check and Finalise unavailable while a retained CV waits for ${paused}`, () => {
    const html = renderToStaticMarkup(createElement(CvAssessmentPanel, {
      id: "test", assessment: null, current: false, finalised: false, busy: false,
      hasContent: true, content, paused,
    }));
    expect(html).toContain(`Open the ${label} in Write`);
    expect(html).toContain("Check and finalise become available after it continues");
    expect(html).not.toContain("Check saved CV");
    expect(html).not.toContain("Finalise this CV");
    expect(html).not.toContain("Saved — check when ready");
  });
}
it("labels a ranked assessment as the member's chosen requirements", async () => {
  const rubric = rubricFixture("Own a budget");
  const review = reviewFixture({ rubric, cv: cvTextItems(content), claims: cvClaimItems(content),
    evidence: cvEvidenceItems(library) });
  const assessment = createCvAssessment({ content, description: "Own a budget", library,
    rubric, review, model: "test", pageCount: 1 });
  assessment.rubric.requirements[0]!.rank = 1;
  const html = await renderSettled(createElement(CvAssessmentPanel, {
    id: "test", assessment, current: true, finalised: false, busy: false,
    hasContent: true, content, library,
  }));
  expect(html).toContain("Coverage of your chosen requirements");
  expect(html).toContain("weighted by your ranked requirements");
});
it("links a completed evidence parent to its continuation without offering another decision", () => {
  const html = renderToStaticMarkup(createElement(CvAssessmentPanel, {
    id: "parent", assessment: null, current: false, finalised: false, busy: false,
    hasContent: true, content, paused: "evidence", continuationDraftId: "child",
  }));
  expect(html).toContain("This evidence checkpoint is complete");
  expect(html).toContain('href="/cv/child"');
  expect(html).not.toContain("Open the evidence questions");
  expect(html).not.toContain("Check saved CV");
  expect(html).not.toContain("Finalise this CV");
});
it("shows evidence questions and actual unsupported wording with a guided finalise-anyway choice", async () => {
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
      revision: 1,
      baseHash: "saved-base",
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
  expect(html).toContain("Review findings");
  expect(html).toContain("Nothing further to add");
  expect(html).toContain("Review final PDF and warnings");
  expect(html).not.toContain("Skip review and finalise anyway");
  expect(html).not.toContain("Your input needed");
  expect(html).toContain("<em>Owned a £10m budget</em>");
  expect(html).toContain("Item");
  expect(html).not.toContain("<blockquote");
  expect(html).not.toContain("<details");
  expect(html).toContain("Full assessment");
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
      revision: 1,
      baseHash: "saved-base",
    }),
  );
  expect(html).toContain("Check saved CV");
  expect(html).toContain("Review final PDF and warnings");
  expect(html).not.toContain("/100");
});

it("gives a finalised CV with a stale assessment a truthful PDF or recovery state", () => {
  const props = { id: "test", assessment: null, current: false, finalised: true, busy: false, hasContent: true, content };
  const kept = renderToStaticMarkup(createElement(CvAssessmentPanel, { ...props, hasFinalPdf: true }));
  expect(kept).toContain("Its saved PDF is still available");
  expect(kept).not.toContain("Assessment required");
  expect(kept).not.toContain("Check saved CV");
  const missing = renderToStaticMarkup(createElement(CvAssessmentPanel, { ...props, hasFinalPdf: false }));
  expect(missing).toContain("Create a new revision");
  expect(missing).not.toContain("Assessment required");
});

it("shows intentional unchecked approval and a direct saved-PDF download", () => {
  const html = renderToStaticMarkup(createElement(CvAssessmentPanel, {
    id: "test", assessment: null, current: false, finalised: true, busy: false,
    hasContent: true, content, hasFinalPdf: true, approvalMode: "unchecked",
  }));
  expect(html).toContain("CV finalised · Not checked");
  expect(html).toContain('href="/api/cv/test/pdf"');
  expect(html).toContain("Download saved PDF");
  expect(html).not.toContain("no longer has a current assessment");
});

it("offers a measured final PDF review for ready saved wording, regardless of Check state", () => {
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
        revision: 1,
        baseHash: "saved-base",
      }),
    );
  expect(render(true, false)).toContain("Review final PDF and warnings");
  expect(render(false, false)).toContain("Review final PDF and warnings");
  expect(render(true, true)).not.toContain("Review final PDF and warnings");
  // Page and factual warnings are measured at the approval step, not guessed from a stale review.
  expect(render(true, false, 4)).toContain("Review final PDF and warnings");
});

it("offers an explicit page-warning choice and explains hard assessment obstacles", () => {
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
  const overPages = renderToStaticMarkup(
    createElement(CvAssessmentPanel, {
      id: "test",
      assessment,
      current: true,
      finalised: false,
      busy: false,
      hasContent: true,
      content,
      revision: 1,
      baseHash: "saved-base",
    }),
  );
  expect(overPages).toContain("Review final PDF and warnings");

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
  expect(stale).toContain("Check saved CV");
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
  expect(html).toMatch(/<fieldset disabled=""[\s\S]*Check saved CV/);
});
