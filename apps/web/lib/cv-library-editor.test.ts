import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { CvLibrary } from "@christopher/core/cv";
import { CvLibraryEditor } from "../components/CvLibraryEditor";

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
  expect(html).toMatch(/<th[^>]*>#<\/th><th[^>]*>Confirmed<\/th><th[^>]*>Narrative<\/th>/);
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
  expect(html).toContain("Version 2 saved");
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
