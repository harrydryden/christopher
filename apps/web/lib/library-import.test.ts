import { describe, expect, it } from "vitest";
import { libraryImportSource, libraryImportView, proposalHeadline, proposedDates } from "./library-import";

const proposal = {
  employment: [{
    id: "job-0", company: "Acme Logistics", title: "Director of Operations", startDate: "2020-03", endDate: "2022-06",
    current: false, quote: "Director of Operations, Acme Logistics",
    responsibilities: [
      { id: "job-0-row-0", text: "Ran the UK warehouse team of 30", quote: "Ran the UK warehouse team of 30" },
      { id: "job-0-row-1", text: "Cut handover time to four hours", quote: "Cut handover time to four hours" },
    ],
  }],
  education: [{ id: "education-0", heading: "University of Leeds", detail: "MSc Operations Management", quote: "MSc" }],
  skills: [{ id: "skill-0", text: "Kanban" }],
};

const row = (over: Record<string, unknown> = {}) => ({
  id: "00000000-0000-4000-8000-000000000000",
  kind: "cv" as const,
  filename: "jane-okafor-cv.pdf",
  url: null,
  proposal: null,
  error: null,
  processedAt: null,
  createdAt: new Date("2026-09-19T09:00:00Z"),
  ...over,
});

describe("libraryImportView", () => {
  it("says the document is being read while the worker still has it", () => {
    expect(libraryImportView(row())).toMatchObject({
      state: "reading", headline: "Reading jane-okafor-cv.pdf…", retryable: false, proposal: null,
    });
  });

  it("stops saying a document is on its way once nothing could still be reading it", () => {
    const started = new Date("2026-09-19T09:00:00Z");
    const busy = new Date(started.getTime() + 3 * 60_000);
    const gone = new Date(started.getTime() + 40 * 60_000);

    // Inside the task's four minutes and its retries, the worker is simply busy.
    expect(libraryImportView(row(), false, busy)).toMatchObject({ state: "reading", stalled: false });
    // Long past them, nothing is coming: the card says so and offers a way out.
    expect(libraryImportView(row(), false, gone)).toMatchObject({ state: "reading", stalled: true });
    // A document that was read is never stalled, however long ago it arrived.
    expect(libraryImportView(row({ proposal, processedAt: busy }), false, gone)).toMatchObject({ state: "proposed", stalled: false });
  });

  it("counts what was proposed and names the document it came from", () => {
    const view = libraryImportView(row({ proposal, processedAt: new Date() }));

    expect(view.state).toBe("proposed");
    expect(view.counts).toEqual({ jobs: 1, rows: 2, education: 1, skills: 1 });
    expect(view.headline).toBe("Found in jane-okafor-cv.pdf: 1 job, 2 responsibilities, 1 qualification and 1 skill");
    expect(view.proposal!.employment[0]!.company).toBe("Acme Logistics");
  });

  it("shows the refusal the worker wrote, and offers to ask again only while the text is still here", () => {
    const failed = row({ error: "There is no readable text in that PDF.", processedAt: new Date() });

    expect(libraryImportView(failed)).toMatchObject({ state: "failed", headline: "Could not read jane-okafor-cv.pdf", retryable: false });
    expect(libraryImportView(failed).error).toBe("There is no readable text in that PDF.");
    // The budget refusal: the document was converted and kept, so one more call would read it.
    expect(libraryImportView(failed, true).retryable).toBe(true);
  });

  it("treats a proposal it cannot make sense of as a refusal rather than taking the page down", () => {
    const view = libraryImportView(row({ proposal: { employment: "everything" }, processedAt: new Date() }));

    expect(view).toMatchObject({ state: "failed", retryable: false });
    expect(view.error).toContain("import the document again");
  });

  it("names a document by its filename, its address or its kind, in that order", () => {
    expect(libraryImportSource({ kind: "cv", filename: "cv.pdf", url: null })).toBe("cv.pdf");
    expect(libraryImportSource({ kind: "website", filename: null, url: "https://www.jane.example/about" })).toBe("jane.example/about");
    expect(libraryImportSource({ kind: "paste", filename: null, url: null })).toBe("Pasted text");
    expect(libraryImportSource({ kind: "linkedin", filename: null, url: null })).toBe("LinkedIn profile");
  });
});

describe("the sentences", () => {
  it("lists only what was found, and says so when nothing was", () => {
    expect(proposalHeadline({ jobs: 4, rows: 17, education: 2, skills: 0 }, "your CV"))
      .toBe("Found in your CV: 4 jobs, 17 responsibilities and 2 qualifications");
    expect(proposalHeadline({ jobs: 0, rows: 0, education: 0, skills: 3 }, "your CV")).toBe("Found in your CV: 3 skills");
    expect(proposalHeadline({ jobs: 0, rows: 0, education: 0, skills: 0 }, "your CV")).toBe("Nothing to add from your CV");
  });

  it("writes the dates a document gave, and nothing where it gave none", () => {
    expect(proposedDates({ startDate: "2020-03", endDate: "2022-06", current: false })).toBe("Mar 2020 – Jun 2022");
    expect(proposedDates({ startDate: "2017", endDate: "", current: true })).toBe("2017 – Present");
    expect(proposedDates({ startDate: "", endDate: "", current: false })).toBe("");
  });
});
