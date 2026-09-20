import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { CvLibrary } from "@christopher/core/cv";
import { CvLibraryEditor } from "../components/CvLibraryEditor";
import { libraryEvidence } from "./cv-library-reviews";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/cv", () => ({ saveCvLibrary: vi.fn() }));

it("renders a labelled confirmation checkbox for every responsibility with its saved state", () => {
  const library: CvLibrary = { name: "Test", contact: "", profile: "", structuredExperience: true,
    employment: [{ id: "job", company: "Acme", industryDescriptions: "Healthcare, SaaS", jobTitle: "Director", startDate: "2020", endDate: "", current: true }],
    entries: [{ id: "one", kind: "experience", status: "active", employmentId: "job", heading: "Director", details: "Led a team\nBuilt tools", confirmedResponsibilities: ["Led a team"] }] };
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, { library, version: 2 }));
  const checkboxes = html.match(/<input[^>]+aria-label="Confirm Acme Director entry \d+"[^>]*>/g)!;
  expect(checkboxes).toHaveLength(2);
  expect(checkboxes[0]).toContain('type="checkbox"');
  expect(checkboxes[0]).toContain('checked=""');
  expect(checkboxes[1]).not.toContain('checked=""');
  expect(html).toContain('aria-label="Acme Director responsibilities and outcomes"');
  expect(html).toMatch(/<th[^>]*>#<\/th><th[^>]*>Confirmed<\/th><th[^>]*>Evidence<\/th><th[^>]*>Evidence type<\/th>/);
  expect(html).toContain('aria-label="Job 1 industry descriptions"');
  expect(html).toContain("Healthcare, SaaS");
  expect(html).toMatch(/<th[^>]*>Company<\/th><th[^>]*>Industry descriptions<\/th><th[^>]*>Job title<\/th>/);
  expect(html).not.toMatch(/<th[^>]*>Entries<\/th>/);
  // What this job still needs before a CV can use it, beside the rows it is about.
  expect(html).toContain("1 of 2 rows confirmed · active");
  expect(html).toContain("Confirm all");
  expect(html).toContain("Save library");
  // The save and what is at stake stay in view; this library can be built from as it stands.
  expect(html).toContain("Ready to build: yes");
  expect(html).toMatch(/sticky bottom-0[^"]*"[\s\S]*Save library/);
  expect(html).toContain("Version 2");
  // The employment grid is a table above `md` and stacked cards below it.
  expect(html).toContain('class="hidden md:block"');
  expect(html).toContain('class="space-y-3 md:hidden"');
});

it("says what an unconfirmed draft library still needs before a CV can be built from it", () => {
  const library: CvLibrary = { name: "Test", contact: "", profile: "", structuredExperience: true,
    employment: [{ id: "job", company: "Acme", jobTitle: "Director", startDate: "2020", endDate: "", current: true }],
    entries: [{ id: "one", kind: "experience", status: "draft", employmentId: "job", heading: "Director", details: "Led a team", confirmedResponsibilities: [] }] };
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, { library, version: 3 }));
  expect(html).toContain("Ready to build: no — activate Acme and confirm its rows");
  expect(html).toContain("0 of 1 row confirmed · draft");
});

it("keeps skill labels in a separate Library panel without appearance controls", () => {
  const library: CvLibrary = { name: "Example", contact: "", profile: "", entries: [{ id: "s", kind: "skill", heading: "Tools", details: "SQL, Python and reporting", skillItems: ["SQL", "Python"] }] };
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, { library, version: 1 }));
  expect(html).toContain('aria-label="Individual skills: Tools"');
  expect(html).toContain('SQL\nPython');
  expect(html).toContain('SQL, Python and reporting');
  expect(html).not.toContain('Page background');
  expect(html).not.toContain('Evidence blocks');
  expect(html).toContain('aria-label="Library sections"');
  expect(html).toContain('id="library-panel-education" aria-labelledby="library-tab-education" hidden=""');
});

it("tags every row with the facet it serves and says what the job is still missing", () => {
  const library: CvLibrary = { name: "Test", contact: "", profile: "", structuredExperience: true,
    employment: [{ id: "job", company: "Acme", jobTitle: "Director", startDate: "2020", endDate: "", current: true }],
    entries: [{ id: "one", kind: "experience", status: "active", employmentId: "job", heading: "Director",
      details: "Led a team\nCut handovers by 40%", confirmedResponsibilities: ["Led a team"],
      rowFacets: { "Led a team": "responsibility", "Cut handovers by 40%": "metric" } }] };
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, { library, version: 4 }));
  // One control per row, defaulting to the facet the person chose and to Unclear when they have not.
  expect(html).toContain('aria-label="Evidence type for Acme Director row 1"');
  expect(html).toContain('aria-label="Evidence type for Acme Director row 2"');
  expect(html).toContain("<option value=\"\">Unclear</option>");
  expect(html).toContain("Problem solved");
  expect(html).toContain("Working style");
  // What the six facets say is missing, from the tags on screen.
  expect(html).toContain("No outcome or problem solved yet · 2 other facets untagged");
  // The stored version is text beside Save, not only the hidden input the save posts.
  expect(html).toContain("Version 4");
});

it("shows the evidence a stored review reports, with a question and a control that answers it", () => {
  const library: CvLibrary = { name: "Test", contact: "", profile: "", structuredExperience: true,
    employment: [{ id: "job", company: "Acme", jobTitle: "Director", startDate: "2020", endDate: "", current: true }],
    entries: [{ id: "one", kind: "experience", status: "active", employmentId: "job", heading: "Director",
      details: "Led a team", confirmedResponsibilities: ["Led a team"] }] };
  const evidence = libraryEvidence(library, new Map(), { pending: true, refusal: null });
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, { library, version: 1, evidence }));
  expect(html).toContain("Evidence: None");
  expect(html).toContain("None");
  expect(html).toContain("Evaluating…");
  expect(html).toContain("What changed as a result?");
  expect(html).toContain("Add a row for this");
  // A score gates nothing: the rows, the confirmation and the save are all still there.
  expect(html).toContain("Save library");
  expect(html).toContain('aria-label="Confirm Acme Director entry 1"');
});

it("opens the Experience tab on a gap carried from a CV, with the requirement quoted", () => {
  const library: CvLibrary = { name: "Test", contact: "", profile: "", structuredExperience: true,
    employment: [{ id: "job", company: "Acme", jobTitle: "Director", startDate: "2020", endDate: "", current: true }],
    entries: [{ id: "one", kind: "experience", status: "active", employmentId: "job", heading: "Director",
      details: "Led a team", confirmedResponsibilities: ["Led a team"] }] };
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, {
    library, version: 1, need: "Five years of experience leading operations in a regulated environment", job: "job",
  }));
  expect(html).toContain("Add evidence for: Five years of experience leading operations in a regulated environment");
  expect(html).toContain("Dismiss");
  expect(html).toContain('id="library-panel-experience" aria-labelledby="library-tab-experience" class=');
  expect(html).toContain('id="library-panel-intro" aria-labelledby="library-tab-intro" hidden=""');

  // An old draft can name a job that has since been deleted. The need is still worth showing.
  const stale = renderToStaticMarkup(createElement(CvLibraryEditor, {
    library, version: 1, need: "Five years leading operations", job: "a-job-that-went",
  }));
  expect(stale).toContain("Add evidence for: Five years leading operations");
  expect(stale).toContain('id="library-panel-experience" aria-labelledby="library-tab-experience" class=');
});

it("does not let a landing evidence score change what the form will post", () => {
  // The poller refreshes this page while somebody is typing into it. The refresh changes only the
  // server's props, and `evidence` must feed the display and nothing else — the value the save
  // posts is the editor's own state, which the refresh reconciles rather than rebuilds.
  const library: CvLibrary = { name: "Test", contact: "", profile: "", structuredExperience: true,
    employment: [{ id: "job", company: "Acme", jobTitle: "Director", startDate: "2020", endDate: "", current: true }],
    entries: [{ id: "one", kind: "experience", status: "active", employmentId: "job", heading: "Director",
      details: "Led a team", confirmedResponsibilities: ["Led a team"] }] };
  const posted = (html: string) => html.match(/name="library" value="([^"]*)"/)![1];
  const waiting = renderToStaticMarkup(createElement(CvLibraryEditor, { library, version: 1, evidence: libraryEvidence(library, new Map(), { pending: true, refusal: null }) }));
  const landed = renderToStaticMarkup(createElement(CvLibraryEditor, { library, version: 1, evidence: libraryEvidence(library, new Map(), { pending: false, refusal: null }) }));
  expect(posted(waiting)).toBe(posted(landed));
  expect(waiting).toContain("Evaluating…");
  expect(landed).not.toContain("Evaluating…");
});
