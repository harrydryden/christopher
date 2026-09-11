import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { CvLibrary } from "@christopher/core/cv";
import { CvLibraryEditor } from "../components/CvLibraryEditor";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/cv", () => ({ saveCvLibrary: vi.fn() }));

it("renders a labelled confirmation checkbox for every responsibility with its saved state", () => {
  const library: CvLibrary = { name: "Test", contact: "", profile: "", structuredExperience: true,
    employment: [{ id: "job", company: "Acme", jobTitle: "Director", startDate: "2020", endDate: "", current: true }],
    entries: [{ id: "one", kind: "experience", status: "active", employmentId: "job", heading: "Director", details: "Led a team\nBuilt tools", confirmedResponsibilities: ["Led a team"] }] };
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, { library, version: 2 }));
  const checkboxes = html.match(/<input[^>]+aria-label="Confirm Acme Director entry \d+"[^>]*>/g)!;
  expect(checkboxes).toHaveLength(2);
  expect(checkboxes[0]).toContain('type="checkbox"');
  expect(checkboxes[0]).toContain('checked=""');
  expect(checkboxes[1]).not.toContain('checked=""');
  expect(html).toContain("Confirmed</label>");
  expect(html).toContain("1 confirmed");
  expect(html).toContain("Save library");
});
