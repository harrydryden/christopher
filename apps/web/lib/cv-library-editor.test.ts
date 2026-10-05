// @vitest-environment jsdom
// jsdom for the one case that clicks through the editor; the rest render to static markup, which
// reads the same in either environment.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { CvLibrary } from "@col/core/cv";
import { CvLibraryEditor } from "../components/CvLibraryEditor";
import { jobRemovalConfirm } from "../components/EmploymentHistoryTable";
import type { LibraryEvidence } from "./cv-library-evidence";
import { libraryEvidence } from "./cv-library-reviews";
import { openStoredLibrary } from "./cv-library-open";
import { saveCvLibrary } from "@/app/actions/cv";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/cv", () => ({ saveCvLibrary: vi.fn(), rescoreLibrary: vi.fn() }));

/** The markup a person can read: everything but the hidden field the save posts. */
const onScreen = (html: string) => html.replace(/name="library" value="[^"]*"/, "");

it("renders a labelled confirmation checkbox for every responsibility with its saved state", () => {
  const library: CvLibrary = { name: "Test", contact: "", profile: "", structuredExperience: true,
    employment: [{ id: "job", company: "Acme", industryDescriptions: "Healthcare, SaaS", jobTitle: "Director", startDate: "2020", endDate: "", current: true }],
    entries: [{ id: "one", kind: "experience", status: "active", employmentId: "job", heading: "Director", details: "Led a team\nBuilt tools", confirmedResponsibilities: ["Led a team"] }] };
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, { library: openStoredLibrary(library), version: 2 }));
  const checkboxes = html.match(/<input[^>]+aria-label="Confirm Acme Director entry \d+"[^>]*>/g)!;
  expect(checkboxes).toHaveLength(2);
  expect(checkboxes[0]).toContain('type="checkbox"');
  expect(checkboxes[0]).toContain('checked=""');
  expect(checkboxes[1]).not.toContain('checked=""');
  expect(html).toContain('aria-label="Acme Director responsibilities and outcomes"');
  expect(html).toMatch(/<th[^>]*>#<\/th><th[^>]*>Confirmed<\/th><th[^>]*>Narrative<\/th><th[^>]*>Type<\/th><th[^>]*>Score<\/th>/);
  expect(html).toContain('aria-label="Job 1 industry descriptions"');
  expect(html).toContain("Healthcare, SaaS");
  expect(html).toMatch(/<th[^>]*>Company<\/th><th[^>]*>Industry descriptions<\/th><th[^>]*>Job title<\/th>/);
  expect(html).not.toMatch(/<th[^>]*>Entries<\/th>/);
  // What this job still needs before a CV can use it, beside the rows it is about. A job in
  // employment history is evidence of itself, so the sentence says nothing about a status.
  expect(html).toContain("1 of 2 rows confirmed");
  expect(html).toContain("Confirm all");
  // Nothing has changed, so there is nothing to save and no bar offering to: saving is the
  // person's own act, and the control for it appears once there is something to save.
  expect(html).not.toContain("Save library");
  expect(html).not.toContain("sticky top-0");
  expect(html).toContain("Ready to build: yes");
  // The employment grid is a table above `md` and stacked cards below it.
  expect(html).toContain("md:table-row");
  expect(html.match(/aria-label="Job 1 company"/g)).toHaveLength(1);
  expect(html.match(/aria-label="Job 1 industry descriptions"/g)).toHaveLength(1);
  expect(html.match(/aria-label="Job 1 title"/g)).toHaveLength(1);
  expect(html.match(/aria-label="Job 1 start date"/g)).toHaveLength(1);
  expect(html.match(/aria-label="Job 1 end date"/g)).toHaveLength(1);
  expect(html.match(/aria-label="Job 1 current"/g)).toHaveLength(1);
  expect(html.match(/aria-label="Acme Director evidence 1"/g)).toHaveLength(1);
});

it("sets the evidence table's column heads in the pixel face's one weight, not a bold <th>", () => {
  // Silkscreen is loaded at 400 only. A <th> is bold by default and preflight does not reset it,
  // so a head that inherited the pixel face from its <thead> would be painted as a faux bold.
  // Each head carries `ds-pixel` itself, as the table component's TH does, which pins 400.
  const library: CvLibrary = { name: "Test", contact: "", profile: "", structuredExperience: true,
    employment: [{ id: "job", company: "Acme", jobTitle: "Director", startDate: "2020", endDate: "", current: true }],
    entries: [{ id: "one", kind: "experience", status: "active", employmentId: "job", heading: "Director", details: "Led a team" }] };
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, { library: openStoredLibrary(library), version: 1 }));
  const table = html.slice(html.indexOf('aria-label="Acme Director responsibilities and outcomes"'));
  const head = table.slice(0, table.indexOf("</thead>"));
  const heads = head.match(/<th [^>]*>/g)!;
  expect(heads).toHaveLength(6);
  for (const th of heads) expect(th).toMatch(/class="ds-pixel[ "]/);
  expect(head).not.toMatch(/<thead[^>]*ds-pixel/);
});

it("offers no state to set on a block and no way to archive one but removing its job", () => {
  const library: CvLibrary = { name: "Test", contact: "", profile: "", structuredExperience: true,
    employment: [{ id: "job", company: "Acme", jobTitle: "Director", startDate: "2020", endDate: "", current: true }],
    entries: [
      { id: "one", kind: "experience", status: "active", employmentId: "job", heading: "Director", details: "Led a team", confirmedResponsibilities: ["Led a team"] },
      { id: "two", kind: "skill", status: "active", heading: "Tools", details: "SQL and Power BI" },
    ] };
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, { library: openStoredLibrary(library), version: 5 }));
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
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, { library: openStoredLibrary(library), version: 3 }));
  expect(html).toContain("Ready to build: no — confirm Acme’s rows");
  expect(html).toContain("0 of 1 row confirmed");
});

it("opens a library an earlier release stored, with its tag and its block intact", () => {
  // Live data: one type per row as a bare string, and a block stored as a draft. Both are read in
  // today's shape by `openStoredLibrary`, which the editor's prop type requires the page to call.
  const stored = {
    name: "Test", contact: "", profile: "", structuredExperience: true,
    employment: [{ id: "job", company: "Acme", jobTitle: "Director", startDate: "2020", endDate: "", current: true }],
    entries: [{
      id: "one", kind: "experience", status: "draft", employmentId: "job", heading: "Director",
      details: "Led a team\nCut handovers by 40%", confirmedResponsibilities: ["Led a team"],
      rowFacets: { "Led a team": "responsibility", "Cut handovers by 40%": "metric" },
    }],
  };
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, { library: openStoredLibrary(stored), version: 6 }));
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
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, { library: openStoredLibrary(library), version: 4 }));
  // One menu button per row, named by the row it belongs to, closed until it is opened.
  expect(html).toMatch(/<button type="button" aria-label="Type of row 1" aria-haspopup="menu" aria-expanded="false"/);
  expect(html).toMatch(/<button type="button" aria-label="Type of row 2" aria-haspopup="menu" aria-expanded="false"/);
  expect(html).not.toContain('role="menu"');
  // The trigger reads back every type chosen, each as the pixel label the menu calls it.
  const second = html.slice(html.indexOf('aria-label="Type of row 2"'));
  expect(second.slice(0, second.indexOf("</button>")).match(/>(Problems solved|Outcomes|Metrics moved)</g))
    .toEqual([">Problems solved<", ">Outcomes<", ">Metrics moved<"]);
  // The trigger fills its cell at the narrative's own minimum height, so the two line up.
  expect(html).toMatch(/<td class="[^"]*md:h-px[^"]*">[\s\S]*?<button[^>]*class="[^"]*h-full min-h-16/);
  expect(html).toMatch(/<textarea[^>]*class="block min-h-16/);
  // What the six types say is missing, from the tags on screen: one row carrying three covers all
  // three, and the word facet is nowhere a person can read it.
  expect(html).toContain("No milestones reached or working style yet");
  expect(html).not.toMatch(/\bfacets? (untagged|are covered)/);
});

it("prompts for a type on a row that has none", () => {
  const library: CvLibrary = { name: "Test", contact: "", profile: "", structuredExperience: true,
    employment: [{ id: "job", company: "Acme", jobTitle: "Director", startDate: "2020", endDate: "", current: true }],
    entries: [{ id: "one", kind: "experience", status: "active", employmentId: "job", heading: "Director", details: "Led a team", confirmedResponsibilities: [] }] };
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, { library: openStoredLibrary(library), version: 1 }));
  expect(html).toContain("Choose types");
  expect(html).toContain("No outcomes or metrics moved yet · 4 other types untagged");
});

it("keeps skill labels in a separate Library panel without appearance controls", () => {
  const library: CvLibrary = { name: "Example", contact: "", profile: "", entries: [{ id: "s", kind: "skill", heading: "Tools", details: "SQL, Python and reporting", skillItems: ["SQL", "Python"] }] };
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, { library: openStoredLibrary(library), version: 1 }));
  expect(html).toContain('aria-label="Individual skills: Tools"');
  expect(html).toContain('SQL\nPython');
  expect(html).toContain('SQL, Python and reporting');
  expect(html).not.toContain('Page background');
  expect(html).not.toContain('Evidence blocks');
  expect(html).toContain('aria-label="Library sections"');
  expect(html).toContain('id="library-panel-education" aria-labelledby="library-tab-education" hidden=""');
});

it("puts the Scoring guide in a fourth tab after Education, hidden until chosen, with nothing to fill in", () => {
  const library: CvLibrary = { name: "Example", contact: "", profile: "", entries: [{ id: "s", kind: "skill", heading: "Tools", details: "SQL" }] };
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, { library: openStoredLibrary(library), version: 1 }));
  const strip = html.slice(html.indexOf('aria-label="Library sections"'));
  expect([...strip.slice(0, strip.indexOf("</div>")).matchAll(/role="tab" id="library-tab-(\w+)"[^>]*>([^<]*)</g)].map(match => [match[1], match[2]]))
    .toEqual([["intro", "Intro"], ["experience", "Experience"], ["education", "Education, skills and interests"], ["guide", "Scoring guide"]]);
  expect(html).toContain('<button type="button" role="tab" id="library-tab-guide" aria-controls="library-panel-guide" aria-selected="false" tabindex="-1"');
  const panel = html.slice(html.indexOf('id="library-panel-guide"'));
  expect(panel).toMatch(/^id="library-panel-guide" aria-labelledby="library-tab-guide" hidden=""/);
  const body = panel.slice(0, panel.indexOf("</form>"));
  expect(body).toContain('<h2 class="ds-pixel text-12">Scoring guide</h2>');
  expect(body).toContain("A strong row says");
  expect(body).not.toMatch(/<(input|select|textarea|button)\b/);
});

it("shows the evidence a stored review reports, with a question and a control that answers it", () => {
  const library: CvLibrary = { name: "Test", contact: "", profile: "", structuredExperience: true,
    employment: [{ id: "job", company: "Acme", jobTitle: "Director", startDate: "2020", endDate: "", current: true }],
    entries: [{ id: "one", kind: "experience", status: "active", employmentId: "job", heading: "Director",
      details: "Led a team", confirmedResponsibilities: ["Led a team"] }] };
  const evidence = libraryEvidence(library, new Map(), { pending: true, refusal: null });
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, { library: openStoredLibrary(library), version: 1, evidence }));
  expect(html).toContain("Evidence: None");
  expect(html).toContain("None");
  expect(html).toContain("Evaluating…");
  expect(html).toContain("What changed as a result?");
  expect(html).toContain("Add a row for this");
  // A score gates nothing: the rows and the confirmation are all still there.
  expect(html).toContain('aria-label="Confirm Acme Director entry 1"');
  // A pass is already running, so there is nothing to re-score and no bar.
  expect(html).not.toContain("Re-score");
});

it("offers the re-score once saved rows have changed since the last review, and scores each row", () => {
  const library: CvLibrary = { name: "Test", contact: "", profile: "", structuredExperience: true,
    employment: [{ id: "job", company: "Acme", jobTitle: "Director", startDate: "2020", endDate: "", current: true }],
    entries: [{ id: "one", kind: "experience", status: "active", employmentId: "job", heading: "Director",
      details: "Led a team\nCut handover time from 3 days to 4 hours across the UK network", confirmedResponsibilities: ["Led a team"],
      rowFacets: { "Cut handover time from 3 days to 4 hours across the UK network": ["outcome"] } }] };
  // No stored review describes these rows and no pass is running: the saved rows are scored from
  // the person's own tags, and the bar offers the full review.
  const evidence = libraryEvidence(library, new Map(), { pending: false, refusal: null });
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, { library: openStoredLibrary(library), version: 3, evidence }));
  expect(html).toMatch(/sticky top-0[^"]*border-b-2 border-line bg-bg[\s\S]*Rows changed since the last review\.[\s\S]*>Re-score</);
  expect(html).not.toContain("Save library");
  expect(html).toContain("Scored from your own tags. Re-score for the full review.");
  // One score cell per row, scored against the row's own types: an untyped row asks for one, a
  // typed row is a button that opens what it is missing. No hover text: the guidance is a click.
  expect(html).toMatch(/<button type="button" aria-label="Select a type for row 1"[^>]*>[\s\S]*?Select type<\/span><\/button>/);
  expect(html).toMatch(/<button type="button" aria-label="Score 50 of 100 for row 2: show what is missing" aria-expanded="false"[^>]*>/);
  expect(html).not.toContain("Row evidence");
  expect(html).not.toMatch(/<button[^>]*aria-label="Score [^"]*"[^>]*title=/);

  // Never saved: nothing to re-score.
  expect(renderToStaticMarkup(createElement(CvLibraryEditor, { library: openStoredLibrary(library), version: 0, evidence }))).not.toContain("Rows changed since the last review");
});

it("gives each contact detail its own field, calls the overview a bio, and has no JSON import or export", () => {
  const library: CvLibrary = { name: "Rowan Mercer", contact: "Manchester, UK · rowan@example.test · +44 7700 900123", profile: "Operations leader", entries: [{ id: "s", kind: "skill", heading: "Tools", details: "SQL" }] };
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, { library: openStoredLibrary(library), version: 2 }));
  // Opened through the upgrade: the address and the number move to their fields, the rest stays.
  expect(html).toMatch(/<span class="ds-label">Email<\/span><input type="email"[^>]*value="rowan@example.test"/);
  expect(html).toMatch(/<span class="ds-label">Phone<\/span><input type="tel"[^>]*value="\+44 7700 900123"/);
  expect(html).toMatch(/<span class="ds-label">Location<\/span><input type="text"[^>]*value=""/);
  expect(html).toMatch(/<span class="ds-label">Other contact details<\/span><input type="text"[^>]*value="Manchester, UK"/);
  // Every intro line is the same control.
  expect(html).toMatch(/<span class="ds-label">Name<\/span><input type="text"/);
  expect(html).toContain('<span class="ds-label">Bio</span>');
  expect(html).not.toMatch(/career overview/i);
  expect(html).not.toMatch(/Import library JSON|Export library/);
  // Opening the old shape is not an edit: nothing to save.
  expect(html).not.toContain("Unsaved changes");
});

it("opens the Experience tab on a gap carried from a CV, with the requirement quoted", () => {
  const library: CvLibrary = { name: "Test", contact: "", profile: "", structuredExperience: true,
    employment: [{ id: "job", company: "Acme", jobTitle: "Director", startDate: "2020", endDate: "", current: true }],
    entries: [{ id: "one", kind: "experience", status: "active", employmentId: "job", heading: "Director",
      details: "Led a team", confirmedResponsibilities: ["Led a team"] }] };
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, {
    library: openStoredLibrary(library), version: 1, need: "Five years of experience leading operations in a regulated environment", job: "job",
  }));
  expect(html).toContain("Add evidence for: Five years of experience leading operations in a regulated environment");
  expect(html).toContain("Dismiss");
  expect(html).toContain('id="library-panel-experience" aria-labelledby="library-tab-experience" class=');
  expect(html).toContain('id="library-panel-intro" aria-labelledby="library-tab-intro" hidden=""');

  // An old draft can name a job that has since been deleted. The need is still worth showing.
  const stale = renderToStaticMarkup(createElement(CvLibraryEditor, {
    library: openStoredLibrary(library), version: 1, need: "Five years leading operations", job: "a-job-that-went",
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
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, { library: openStoredLibrary(library), version: 8 }));
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
  expect(renderToStaticMarkup(createElement(CvLibraryEditor, { library: openStoredLibrary(live), version: 1 }))).not.toContain("Archived jobs");

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
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, { library: openStoredLibrary(removed), version: 9 }));
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

it("tags an untyped row with the full review's reading when the person adopts it from the score panel", () => {
  const library: CvLibrary = { name: "Test", contact: "", profile: "", structuredExperience: true,
    employment: [{ id: "job", company: "Acme", jobTitle: "Director", startDate: "2020", endDate: "", current: true }],
    entries: [{ id: "one", kind: "experience", status: "active", employmentId: "job", heading: "Director",
      details: "Led a team of six for the board", confirmedResponsibilities: ["Led a team of six for the board"] }] };
  // A model review read the untagged row as a Responsibilities row; the person never tagged it.
  const evidence: LibraryEvidence = { line: null, refusal: null, evaluating: false, entries: [{
    entryId: "one", employmentId: "job", label: "Director · Acme", score: 0, rating: "none", source: "model",
    provisional: false, evaluating: false, missing: [], missingLine: "", prompts: [],
    reviewedRows: ["Led a team of six for the board"],
    rows: [{ row: "Led a team of six for the board", tagged: [], marks: ["responsibility.ownership", "responsibility.audience"], reviewFacets: ["responsibility"], verified: true }],
  }] };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(createElement(CvLibraryEditor, { library: openStoredLibrary(library), version: 1, evidence })));
  const posted = () => JSON.parse(container.querySelector<HTMLInputElement>('input[name="library"]')!.value) as CvLibrary;
  expect(posted().entries[0]!.rowFacets ?? {}).toEqual({});

  act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Select a type for row 1"]')!.click());
  const adopt = document.querySelector<HTMLButtonElement>('button[aria-label="Tag row 1 as Responsibilities"]')!;
  expect(adopt.textContent).toBe("Use these types");
  act(() => adopt.click());

  // The same path the Type menu takes: the row is tagged in what the save will post, the menu reads
  // it back, and the score cell scores it against the review's marks.
  expect(posted().entries[0]!.rowFacets).toEqual({ "Led a team of six for the board": ["responsibility"] });
  expect(container.querySelector('button[aria-label="Type of row 1"]')!.textContent).toContain("Responsibilities");
  expect(container.querySelector('button[aria-label="Score 50 of 100 for row 1: show what is missing"]')).not.toBeNull();
  expect(document.querySelector("[role=dialog]")).toBeNull();
  act(() => root.unmount());
  container.remove();
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
  const waiting = renderToStaticMarkup(createElement(CvLibraryEditor, { library: openStoredLibrary(library), version: 1, evidence: libraryEvidence(library, new Map(), { pending: true, refusal: null }) }));
  const landed = renderToStaticMarkup(createElement(CvLibraryEditor, { library: openStoredLibrary(library), version: 1, evidence: libraryEvidence(library, new Map(), { pending: false, refusal: null }) }));
  expect(posted(waiting)).toBe(posted(landed));
  expect(waiting).toContain("Evaluating…");
  expect(landed).not.toContain("Evaluating…");
});

it("counts pasted skills live, flags long labels, and normalises on submit without a blur", async () => {
  const details = `${"Long supporting explanation, with commas. ".repeat(6).trim()}\nSecond paragraph stays exactly as written.`;
  const library: CvLibrary = { name: "Test", contact: "", profile: "", entries: [{ id: "skills", kind: "skill", heading: "Commercial", details }] };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  vi.mocked(saveCvLibrary).mockResolvedValue({ ok: false, error: "Test save" });
  try {
    await act(async () => root.render(createElement(CvLibraryEditor, { library: openStoredLibrary(library), version: 1 })));
    const textarea = container.querySelector<HTMLTextAreaElement>('[aria-label="Individual skills: Commercial"]')!;
    const type = async (text: string) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
      await act(async () => textarea.dispatchEvent(new Event("input", { bubbles: true })));
    };
    await type("Financial Planning & Analysis, P&L Management, Unit Economics, Product Operations, Customer Success, Customer Support");
    expect(container.textContent).toContain("6/20 individual skills");
    await type("A".repeat(120));
    expect(container.textContent).toContain("Skill 1 is approaching 150 characters.");
    await type("A".repeat(151));
    expect(container.textContent).toContain("Skill 1 is 151 characters; the limit is 150.");
    expect([...container.querySelectorAll("button")].find(button => button.textContent === "Save library")?.disabled).toBe(true);
    await type("Financial Planning & Analysis, P&L Management, Unit Economics, Product Operations, Customer Success, Customer Support");
    const form = container.querySelector<HTMLFormElement>("form")!;
    await act(async () => form.requestSubmit());
    const sent = vi.mocked(saveCvLibrary).mock.calls.at(-1)?.[1] as FormData;
    const saved = JSON.parse(String(sent.get("library"))) as CvLibrary;
    expect(saved.entries[0]?.skillItems).toEqual(["Financial Planning & Analysis", "P&L Management", "Unit Economics", "Product Operations", "Customer Success", "Customer Support"]);
    expect(saved.entries[0]?.details).toBe(details);
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.mocked(saveCvLibrary).mockReset();
  }
});

it("preserves a canonical comma skill through focus, blur and unrelated Library edits", async () => {
  const library: CvLibrary = { name: "Test", contact: "", profile: "Original bio", entries: [
    { id: "skills", kind: "skill", heading: "Compliance", details: "Original scope", skillItems: ["Governance, risk and compliance", "Reporting"] },
  ] };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  vi.mocked(saveCvLibrary).mockResolvedValue({ ok: false, error: "Test save" });
  try {
    await act(async () => root.render(createElement(CvLibraryEditor, { library: openStoredLibrary(library), version: 1 })));
    const skills = container.querySelector<HTMLTextAreaElement>('[aria-label="Individual skills: Compliance"]')!;
    expect(container.textContent).toContain("2/20 individual skills");
    await act(async () => { skills.focus(); skills.blur(); });
    expect(skills.value).toBe("Governance, risk and compliance\nReporting");
    const bio = container.querySelector<HTMLTextAreaElement>('#library-panel-intro textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(bio, "New bio");
    await act(async () => bio.dispatchEvent(new Event("input", { bubbles: true })));
    const details = [...container.querySelectorAll<HTMLTextAreaElement>('#library-panel-education textarea')].find(item => item !== skills)!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(details, "New scope, with a comma.");
    await act(async () => details.dispatchEvent(new Event("input", { bubbles: true })));
    await act(async () => container.querySelector<HTMLFormElement>("form")!.requestSubmit());
    const sent = vi.mocked(saveCvLibrary).mock.calls.at(-1)?.[1] as FormData;
    expect(JSON.parse(String(sent.get("editedSkillIds")))).toEqual([]);
    const saved = JSON.parse(String(sent.get("library"))) as CvLibrary;
    expect(saved.entries[0]?.skillItems).toEqual(["Governance, risk and compliance", "Reporting"]);
    expect(saved.entries[0]?.details).toBe("New scope, with a comma.");
    expect(saved.profile).toBe("New bio");
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.mocked(saveCvLibrary).mockReset();
  }
});

it("splits a stored combined skill only on request and preserves its supporting details on save", async () => {
  const combined = "Financial Planning & Analysis, P&L Management, Unit Economics, Product Operations, Customer Success, Customer Support";
  const details = "Financial planning across products, with reporting and support handovers.\nResults stay with this evidence.";
  const library: CvLibrary = { name: "Test", contact: "London", profile: "Commercial leader", entries: [
    { id: "skills", kind: "skill", heading: "Commercial", details, skillItems: [combined] },
  ] };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  vi.mocked(saveCvLibrary).mockResolvedValue({ ok: false, error: "Test save" });
  try {
    await act(async () => root.render(createElement(CvLibraryEditor, { library: openStoredLibrary(library), version: 1 })));
    const skills = container.querySelector<HTMLTextAreaElement>('[aria-label="Individual skills: Commercial"]')!;
    expect(container.textContent).toContain("1/20 individual skills");
    await act(async () => { skills.focus(); skills.blur(); });
    expect(skills.value).toBe(combined);
    const split = container.querySelector<HTMLButtonElement>('[aria-label="Split skill 1 in Commercial into separate skills"]')!;
    expect(split).toBeTruthy();
    await act(async () => split.click());
    expect(container.textContent).toContain("6/20 individual skills");
    expect(skills.value).toBe("Financial Planning & Analysis\nP&L Management\nUnit Economics\nProduct Operations\nCustomer Success\nCustomer Support");
    await act(async () => container.querySelector<HTMLFormElement>("form")!.requestSubmit());
    const sent = vi.mocked(saveCvLibrary).mock.calls.at(-1)?.[1] as FormData;
    expect(JSON.parse(String(sent.get("editedSkillIds")))).toEqual(["skills"]);
    const saved = JSON.parse(String(sent.get("library"))) as CvLibrary;
    expect(saved.entries[0]?.skillItems).toEqual([
      "Financial Planning & Analysis", "P&L Management", "Unit Economics", "Product Operations", "Customer Success", "Customer Support",
    ]);
    expect(saved.entries[0]?.details).toBe(details);
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.mocked(saveCvLibrary).mockReset();
  }
});

it("shows why a combined Library skill cannot be split past the 20-label limit", () => {
  const library: CvLibrary = { name: "Test", contact: "", profile: "", entries: [
    { id: "skills", kind: "skill", heading: "Tools", details: "Tooling experience", skillItems: [
      ...Array.from({ length: 19 }, (_, index) => `Tool ${index + 1}`), "SQL, Python",
    ] },
  ] };
  const html = renderToStaticMarkup(createElement(CvLibraryEditor, { library: openStoredLibrary(library), version: 1 }));
  expect(html).toContain("Splitting makes 21 skills; maximum 20. Remove some first.");
  expect(html).toMatch(/aria-label="Split skill 20 in Tools into separate skills"[^>]*disabled=""/);
});

it("keeps the exact unsaved draft after a conflicting reload and lets the person choose their wording", async () => {
  const base: CvLibrary = { name: "Rowan", contact: "", profile: "First bio", structuredExperience: true,
    employment: [{ id: "job", company: "Acme", jobTitle: "Director", startDate: "2020", endDate: "", current: true }],
    entries: [{ id: "one", kind: "experience", status: "active", employmentId: "job", heading: "Director", details: "Led a team", confirmedResponsibilities: ["Led a team"] }] };
  const latest: CvLibrary = { ...base, profile: "Saved in another tab" };
  vi.mocked(saveCvLibrary).mockResolvedValue({ ok: false, error: "The library changed. Reload before saving." });
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: 2, content: openStoredLibrary(latest) }) });
  vi.stubGlobal("fetch", fetch);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const posted = () => JSON.parse(container.querySelector<HTMLInputElement>('input[name="library"]')!.value) as CvLibrary;
  const button = (label: string) => [...container.querySelectorAll("button")].find(item => item.textContent === label)!;
  try {
    await act(async () => root.render(createElement(CvLibraryEditor, { library: openStoredLibrary(base), version: 1 })));
    const bio = container.querySelector<HTMLTextAreaElement>('#library-panel-intro textarea')!;
    // Use the prototype setter so React observes the same native input event as a person typing.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(bio, "My unsaved bio");
    await act(async () => bio.dispatchEvent(new Event("input", { bubbles: true })));
    expect(posted().profile).toBe("My unsaved bio");
    await act(async () => button("Save library").click());
    expect(button("Reload and keep my text")).toBeTruthy();
    await act(async () => { button("Reload and keep my text").click(); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(fetch).toHaveBeenCalledOnce();
    expect(posted().profile).toBe("Saved in another tab");
    expect(container.textContent).toContain("My unsaved bio");
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Original unsaved Library draft"]')!.value).toContain("My unsaved bio");
    expect(button("Save library")).toBeUndefined();
    expect(container.textContent).toContain("Choose wording for 1 conflict before saving");
    await act(async () => { button("Use my version").click(); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(posted().profile).toBe("My unsaved bio");
    expect(button("Save library").disabled).toBe(false);
    expect(button("Reload and keep my text")).toBeUndefined();
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.mocked(saveCvLibrary).mockReset();
  }
});
