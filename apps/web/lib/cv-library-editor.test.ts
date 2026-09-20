import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { CvLibrary } from "@christopher/core/cv";
import { CvLibraryEditor } from "../components/CvLibraryEditor";
import { jobRemovalConfirm } from "../components/EmploymentHistoryTable";
import { libraryEvidence } from "./cv-library-reviews";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/cv", () => ({ saveCvLibrary: vi.fn() }));

/** The markup a person can read: everything but the hidden field the save posts. */
const onScreen = (html: string) => html.replace(/name="library" value="[^"]*"/, "");

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
  expect(html).toMatch(/<th[^>]*>#<\/th><th[^>]*>Confirmed<\/th><th[^>]*>Narrative<\/th><th[^>]*>Type<\/th>/);
  expect(html).toContain('aria-label="Job 1 industry descriptions"');
  expect(html).toContain("Healthcare, SaaS");
  expect(html).toMatch(/<th[^>]*>Company<\/th><th[^>]*>Industry descriptions<\/th><th[^>]*>Job title<\/th>/);
  expect(html).not.toMatch(/<th[^>]*>Entries<\/th>/);
  // What this job still needs before a CV can use it, beside the rows it is about. A job in
  // employment history is evidence of itself, so the sentence says nothing about a status.
  expect(html).toContain("1 of 2 rows confirmed");
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

it("offers no state to set on a block and no way to archive one but removing its job", () => {
  const library: CvLibrary = { name: "Test", contact: "", profile: "", structuredExperience: true,
    employment: [{ id: "job", company: "Acme", jobTitle: "Director", startDate: "2020", endDate: "", current: true }],
    entries: [
      { id: "one", kind: "experience", status: "active", employmentId: "job", heading: "Director", details: "Led a team", confirmedResponsibilities: ["Led a team"] },
      { id: "two", kind: "skill", status: "active", heading: "Tools", details: "SQL and Power BI" },
    ] };
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, { library, version: 5 }));
  expect(html).not.toMatch(/aria-label="Status:/);
  expect(html).not.toContain("Archive block");
  expect(html).not.toContain("Draft — excluded from CVs");
  expect(html).not.toContain("Active — eligible for CVs");
  expect(html).not.toMatch(/activate/i);
  // Removing the job is the control that archives its evidence, and it is never disabled.
  expect(html).toMatch(/<button[^>]*title="Remove job"[^>]*aria-label="Remove job 1"/);
  expect(html).not.toContain("This job has an evidence block");
});

it("says what a library with nothing confirmed still needs before a CV can be built from it", () => {
  const library: CvLibrary = { name: "Test", contact: "", profile: "", structuredExperience: true,
    employment: [{ id: "job", company: "Acme", jobTitle: "Director", startDate: "2020", endDate: "", current: true }],
    entries: [{ id: "one", kind: "experience", status: "active", employmentId: "job", heading: "Director", details: "Led a team", confirmedResponsibilities: [] }] };
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, { library, version: 3 }));
  expect(html).toContain("Ready to build: no — confirm Acme’s rows");
  expect(html).toContain("0 of 1 row confirmed");
});

it("opens a library an earlier release stored, with its tag and its block intact", () => {
  // Live data: one type per row as a bare string, and a block stored as a draft. Both are read in
  // today's shape by the editor itself, so the page cannot hand it anything it will not open.
  const stored = {
    name: "Test", contact: "", profile: "", structuredExperience: true,
    employment: [{ id: "job", company: "Acme", jobTitle: "Director", startDate: "2020", endDate: "", current: true }],
    entries: [{
      id: "one", kind: "experience", status: "draft", employmentId: "job", heading: "Director",
      details: "Led a team\nCut handovers by 40%", confirmedResponsibilities: ["Led a team"],
      rowFacets: { "Led a team": "responsibility", "Cut handovers by 40%": "metric" },
    }],
  };
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, { library: stored as unknown as CvLibrary, version: 6 }));
  // The block is evidence of a job the person still lists: usable, and countable towards a build.
  expect(html).toContain("Ready to build: yes");
  expect(html).toContain("1 of 2 rows confirmed");
  // The stored tag reads as the one type it is, and the row that carries it says so.
  expect(html).toContain("Responsibilities");
  expect(html).toContain("Metrics moved");
  // What the editor will post is the upgraded shape: a list of types, and no draft.
  expect(html).toContain("&quot;rowFacets&quot;:{&quot;Led a team&quot;:[&quot;responsibility&quot;]");
  expect(html).not.toContain("&quot;status&quot;:&quot;draft&quot;");
});

it("tags every row with the types it serves and says what the job is still missing", () => {
  const library: CvLibrary = { name: "Test", contact: "", profile: "", structuredExperience: true,
    employment: [{ id: "job", company: "Acme", jobTitle: "Director", startDate: "2020", endDate: "", current: true }],
    entries: [{ id: "one", kind: "experience", status: "active", employmentId: "job", heading: "Director",
      details: "Led a team\nCut handovers by 40% after the site moved", confirmedResponsibilities: ["Led a team"],
      rowFacets: { "Led a team": ["responsibility"], "Cut handovers by 40% after the site moved": ["problem", "outcome", "metric"] } }] };
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, { library, version: 4 }));
  // One control per row, named by the row it belongs to, and findable whether or not it is open.
  expect(html).toMatch(/<details role="group" aria-label="Type of row 1"/);
  expect(html).toMatch(/<summary aria-label="Type of row 1"/);
  expect(html).toMatch(/<details role="group" aria-label="Type of row 2"/);
  // The summary reads back what is chosen; past two it is the first two and how many more.
  expect(html).toContain("Responsibilities</span>");
  expect(html).toContain("Problems solved · Outcomes +1");
  // Six checkboxes in the panel, in the order the Library asks for them. The panel is laid out
  // against the viewport rather than the cell, so the scroller around the table cannot clip it.
  const panel = html.slice(html.indexOf('<div class="fixed', html.indexOf('aria-label="Type of row 1"')));
  expect(panel.match(/Responsibilities|Problems solved|Outcomes|Metrics moved|Milestones reached|Working style/g)!.slice(0, 6))
    .toEqual(["Responsibilities", "Problems solved", "Outcomes", "Metrics moved", "Milestones reached", "Working style"]);
  // What the six types say is missing, from the tags on screen: one row carrying three covers all
  // three, and the word facet is nowhere a person can read it.
  expect(html).toContain("No milestones reached or working style yet");
  expect(html).not.toMatch(/\bfacets? (untagged|are covered)/);
  // The stored version is text beside Save, not only the hidden input the save posts.
  expect(html).toContain("Version 4");
});

it("prompts for a type on a row that has none", () => {
  const library: CvLibrary = { name: "Test", contact: "", profile: "", structuredExperience: true,
    employment: [{ id: "job", company: "Acme", jobTitle: "Director", startDate: "2020", endDate: "", current: true }],
    entries: [{ id: "one", kind: "experience", status: "active", employmentId: "job", heading: "Director", details: "Led a team", confirmedResponsibilities: [] }] };
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, { library, version: 1 }));
  expect(html).toContain("Choose a type");
  expect(html).toContain("No outcomes or metrics moved yet · 4 other types untagged");
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

it("shows neither a removed job nor the evidence archived with it", () => {
  // What a save stores when a job is removed: the record is kept, because the block archived with
  // it points at it. Neither is on the screen again, and neither counts towards a build.
  const library: CvLibrary = { name: "Test", contact: "", profile: "", structuredExperience: true,
    employment: [
      { id: "job", company: "Acme", jobTitle: "Director", startDate: "2020", endDate: "", current: true },
      { id: "gone", company: "Globex", jobTitle: "Head of Operations", startDate: "2015", endDate: "2019", current: false },
    ],
    entries: [
      { id: "one", kind: "experience", status: "active", employmentId: "job", heading: "Director", details: "Led a team", confirmedResponsibilities: [] },
      { id: "two", kind: "experience", status: "inactive", employmentId: "gone", heading: "Head of Operations", details: "Ran the estate", confirmedResponsibilities: ["Ran the estate"] },
    ] };
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, { library, version: 8 }));
  // Everything above the Archived jobs disclosure is the editor proper: employment history, the
  // rows tables, the readiness lines. The removed job is in none of it, and its wording is
  // nowhere on the page at all.
  const editing = onScreen(html).slice(0, onScreen(html).indexOf("Archived jobs"));
  expect(editing).not.toContain("Globex");
  expect(onScreen(html)).not.toContain("Ran the estate");
  expect(editing).toContain("Acme");
  // Archived evidence is never counted, so this library is not ready on the strength of it.
  expect(html).toContain("Ready to build: no — confirm Acme’s rows");
  // It is still what the save will post, so the version that kept it keeps it.
  expect(html).toContain("&quot;Ran the estate&quot;");
});

it("offers a way back from every removal, and nothing at all when nothing was removed", () => {
  const live: CvLibrary = { name: "Test", contact: "", profile: "", structuredExperience: true,
    employment: [{ id: "job", company: "Acme", jobTitle: "Director", startDate: "2020", endDate: "", current: true }],
    entries: [{ id: "one", kind: "experience", status: "active", employmentId: "job", heading: "Director", details: "Led a team", confirmedResponsibilities: [] }] };
  // Nothing is archived, so there is no disclosure: this is the way back from a removal, not a
  // state control, and it is invisible until there is something to come back from.
  expect(renderToStaticMarkup(createElement(CvLibraryEditor, { library: live, version: 1 }))).not.toContain("Archived jobs");

  const removed: CvLibrary = { ...live,
    employment: [
      live.employment![0]!,
      { id: "gone", company: "Globex", jobTitle: "Head of Operations", startDate: "2015", endDate: "2019", current: false },
    ],
    entries: [
      live.entries[0]!,
      { id: "two", kind: "experience", status: "inactive", employmentId: "gone", heading: "Head of Operations", details: "Ran the estate\nMoved the depot", confirmedResponsibilities: [] },
      // And a block the release before this one archived with its own control, which the
      // education panel does not show either.
      { id: "three", kind: "skill", status: "inactive", heading: "Tools", details: "SQL and Power BI" },
    ] };
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, { library: removed, version: 9 }));
  // One disclosure, counting everything it lists, collapsed until it is opened.
  expect(html).toContain("<summary class=\"cursor-pointer text-12 text-muted\">Archived jobs (2)</summary>");
  expect(html).not.toContain("<details open");
  // Each one by the heading employment history gives it, and how much comes back with it.
  expect(html).toContain("Head of Operations · Globex · 2015 – 2019 · 2 rows");
  expect(html).toContain('aria-label="Restore Head of Operations · Globex · 2015 – 2019"');
  expect(html).toContain('aria-label="Restore Tools"');
  expect(html).toContain("save the library to keep it");
  // Restoring changes what is on the screen and nothing else: the block is still archived in what
  // the form would post until the person saves.
  expect(html).toContain("&quot;status&quot;:&quot;inactive&quot;");
});

it("says there is a way back before the job is removed", () => {
  const job = { id: "gone", company: "Globex", jobTitle: "Head of Operations", startDate: "2015", endDate: "2019", current: false };
  expect(jobRemovalConfirm(job, 2)).toBe(
    "Remove Globex · Head of Operations and archive its 2 rows? They stay in earlier versions and in CVs already built. You can restore it from Archived jobs below.",
  );
  // One row is one row, and a job with nothing typed into it yet is still named something.
  expect(jobRemovalConfirm(job, 1)).toContain("archive its 1 row?");
  expect(jobRemovalConfirm({ ...job, company: " ", jobTitle: "" }, 1)).toContain("Remove this job and archive");
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
