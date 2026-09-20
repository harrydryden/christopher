/**
 * The rule that makes a document import safe: nothing reaches the Library that the document does
 * not say, and nothing already in the Library is changed by one.
 */
import { describe, expect, it } from "vitest";
import {
  countProposedItems,
  parseLibraryAdditions,
  proposalToLibraryAdditions,
  proposedItemIds,
  validateLibraryProposal,
  type LibraryProposal,
} from "./library-import";
import { CvLibrarySchema, responsibilityRows, type CvLibrary } from "./cv";

const DOCUMENT = [
  "Jane Okafor — Operations leader",
  "",
  "Director of Operations, Acme Logistics, Mar 2020 – Jun 2022",
  "• Ran the UK warehouse team of 30 through a move to a new site",
  "• Cut handover time from two days to four hours",
  "",
  "Head of Delivery, Northwind, 2017 – 2020",
  "• Reduced stockouts by 18% in one quarter",
  "",
  "MSc Operations Management, University of Leeds, 2014",
  "",
  "Skills: Kanban, S&OP, Warehouse management",
].join("\n");

/** What the extraction returns for the document above, before anything has been checked. */
function plan(over: Record<string, unknown> = {}) {
  return {
    employment: [
      {
        company: "Acme Logistics",
        title: "Director of Operations",
        startDate: "2020-03",
        endDate: "2022-06",
        current: false,
        quote: "Director of Operations, Acme Logistics, Mar 2020 – Jun 2022",
        responsibilities: [
          { text: "Ran the UK warehouse team of 30 through a move to a new site", quote: "Ran the UK warehouse team of 30" },
          { text: "Cut handover time from two days to four hours", quote: "Cut handover time from two days to four hours" },
        ],
      },
    ],
    education: [
      { heading: "University of Leeds", detail: "MSc Operations Management, University of Leeds, 2014", quote: "MSc Operations Management" },
    ],
    skills: [{ text: "Kanban" }, { text: "S&OP" }],
    ...over,
  };
}

const validated = () => validateLibraryProposal(DOCUMENT, plan()).proposal;

describe("validateLibraryProposal", () => {
  it("keeps what the document says, with the ids the accept controls name items by", () => {
    const { proposal, dropped } = validateLibraryProposal(DOCUMENT, plan());

    expect(dropped).toBe(0);
    expect(proposal.employment).toHaveLength(1);
    expect(proposal.employment[0]).toMatchObject({
      id: "job-0", company: "Acme Logistics", title: "Director of Operations",
      startDate: "2020-03", endDate: "2022-06", current: false,
    });
    expect(proposal.employment[0]!.responsibilities.map(row => row.id)).toEqual(["job-0-row-0", "job-0-row-1"]);
    expect(proposal.education.map(item => item.id)).toEqual(["education-0"]);
    expect(proposal.skills.map(item => [item.id, item.text])).toEqual([["skill-0", "Kanban"], ["skill-1", "S&OP"]]);
    expect(countProposedItems(proposal)).toEqual({ jobs: 1, rows: 2, education: 1, skills: 2 });
    expect(proposedItemIds(proposal)).toEqual(["job-0", "job-0-row-0", "job-0-row-1", "education-0", "skill-0", "skill-1"]);
  });

  it("drops a job the document never mentions, and the rows that hang on it", () => {
    const { proposal, dropped } = validateLibraryProposal(DOCUMENT, plan({
      employment: [
        ...plan().employment,
        {
          company: "Globex", title: "Chief Operating Officer", quote: "Chief Operating Officer, Globex",
          responsibilities: [{ text: "Owned a £40m P&L", quote: "Owned a £40m P&L" }],
        },
      ],
    }));

    expect(proposal.employment.map(job => job.company)).toEqual(["Acme Logistics"]);
    // The invented job and its invented row.
    expect(dropped).toBe(2);
  });

  it("drops a job whose title was upgraded, however real the employer is", () => {
    const { proposal, dropped } = validateLibraryProposal(DOCUMENT, plan({
      employment: [{ ...plan().employment[0], title: "Chief Operations Officer", responsibilities: [] }],
    }));

    expect(proposal.employment).toEqual([]);
    expect(dropped).toBe(1);
  });

  it("drops an unanchored responsibility and keeps its neighbours", () => {
    const { proposal, dropped } = validateLibraryProposal(DOCUMENT, plan({
      employment: [{
        ...plan().employment[0],
        responsibilities: [
          ...plan().employment[0]!.responsibilities,
          { text: "Saved £2.4m a year across the network", quote: "Saved £2.4m a year" },
          // Read from the document, but the quote behind it was not.
          { text: "Reduced stockouts by 18% in one quarter", quote: "Reduced stockouts by 40% in one quarter" },
        ],
      }],
    }));

    expect(proposal.employment[0]!.responsibilities.map(row => row.text))
      .toEqual(["Ran the UK warehouse team of 30 through a move to a new site", "Cut handover time from two days to four hours"]);
    expect(dropped).toBe(2);
  });

  it("anchors through line breaks, punctuation width and repeated spaces", () => {
    const wrapped = "Ran the UK warehouse team\n   of 30 through a move to a new site";
    const { proposal, dropped } = validateLibraryProposal(DOCUMENT.replace("Ran the UK warehouse team of 30 through a move to a new site", wrapped), plan({
      employment: [{
        ...plan().employment[0],
        // Full-width characters: NFKC folds them before the containment test.
        company: "Ａcme Logistics".normalize("NFD"),
        responsibilities: [{ text: "Ran the UK warehouse team of 30 through a move to a new site", quote: "a move to a new site" }],
      }],
    }));

    expect(dropped).toBe(0);
    expect(proposal.employment[0]!.company).toBe("Acme Logistics");
    expect(proposal.employment[0]!.responsibilities).toHaveLength(1);
  });

  it("leaves a date the document does not carry blank rather than guessing it", () => {
    const { proposal } = validateLibraryProposal(DOCUMENT, plan({
      employment: [{ ...plan().employment[0], startDate: "2019-01", endDate: "2022-06" }],
    }));

    // 2019 appears nowhere in the CV; 2022 does.
    expect(proposal.employment[0]).toMatchObject({ startDate: "", endDate: "2022-06" });
  });

  it("refuses a date it could not have read as a date, and clears an end date on a current job", () => {
    const { proposal } = validateLibraryProposal(DOCUMENT, plan({
      employment: [
        { ...plan().employment[0], startDate: "March 2020", endDate: "2022", current: false, responsibilities: [] },
        { ...plan().employment[0], company: "Northwind", title: "Head of Delivery", quote: "Head of Delivery, Northwind, 2017 – 2020",
          startDate: "2017", endDate: "2020", current: true, responsibilities: [] },
      ],
    }));

    expect(proposal.employment[0]).toMatchObject({ startDate: "", endDate: "2022" });
    expect(proposal.employment[1]).toMatchObject({ startDate: "2017", endDate: "", current: true });
  });

  it("drops a skill and a qualification the document does not support", () => {
    const { proposal, dropped } = validateLibraryProposal(DOCUMENT, plan({
      skills: [{ text: "Kanban" }, { text: "kanban" }, { text: "Six Sigma" }],
      education: [
        ...plan().education,
        { heading: "MBA", detail: "MBA, INSEAD, 2016", quote: "MBA, INSEAD" },
      ],
    }));

    expect(proposal.skills.map(item => item.text)).toEqual(["Kanban"]);
    expect(proposal.education.map(item => item.heading)).toEqual(["University of Leeds"]);
    // The repeated skill, the invented skill and the invented qualification.
    expect(dropped).toBe(3);
  });

  it("is idempotent, so an accepted proposal can be anchored a second time", () => {
    const first = validateLibraryProposal(DOCUMENT, plan());
    const second = validateLibraryProposal(DOCUMENT, first.proposal);

    expect(second.dropped).toBe(0);
    expect(second.proposal).toEqual(first.proposal);
  });

  it("finds nothing in a document about somebody else", () => {
    const { proposal, dropped } = validateLibraryProposal("An unrelated page about warehousing.", plan());

    expect(proposal).toEqual({ employment: [], education: [], skills: [] });
    expect(dropped).toBeGreaterThan(0);
  });

  it("refuses output that is not a proposal at all", () => {
    expect(() => validateLibraryProposal(DOCUMENT, { employment: "everything" })).toThrow();
  });
});

const library = (over: Partial<CvLibrary> = {}): CvLibrary => CvLibrarySchema.parse({
  name: "Jane Okafor",
  contact: "jane@example.com",
  profile: "Operations leader",
  structuredExperience: true,
  employment: [{ id: "job1", company: "Acme Logistics", jobTitle: "Director of Operations", startDate: "2020-03", endDate: "2022-06", current: false }],
  entries: [{
    id: "existing", kind: "experience", status: "active", heading: "Director of Operations · Acme Logistics", employmentId: "job1",
    details: "Cut handover time from two days to four hours", confirmedResponsibilities: ["Cut handover time from two days to four hours"],
  }],
  ...over,
});

describe("proposalToLibraryAdditions", () => {
  it("lands accepted items as draft blocks with nothing confirmed", () => {
    const proposal = validated();
    const { library: next, added } = proposalToLibraryAdditions(null, proposal, proposedItemIds(proposal), { prefix: "abc", name: "Jane Okafor" });

    expect(added).toEqual({ jobs: 1, rows: 2, education: 1, skills: 2 });
    expect(next.employment).toEqual([{ id: "abc:job-0", company: "Acme Logistics", jobTitle: "Director of Operations", startDate: "2020-03", endDate: "2022-06", current: false }]);
    const experience = next.entries.find(entry => entry.kind === "experience")!;
    expect(experience).toMatchObject({ status: "draft", employmentId: "abc:job-0", confirmedResponsibilities: [] });
    expect(responsibilityRows(experience.details)).toEqual([
      "Ran the UK warehouse team of 30 through a move to a new site",
      "Cut handover time from two days to four hours",
    ]);
    expect(next.entries.find(entry => entry.kind === "education")).toMatchObject({ status: "draft", heading: "University of Leeds" });
    expect(next.entries.find(entry => entry.kind === "skill")).toMatchObject({ status: "draft", skillItems: ["Kanban", "S&OP"] });
    // Valid the moment it is saved, without another pass by hand.
    expect(() => parseLibraryAdditions(next)).not.toThrow();
  });

  it("adds only what was ticked, and no row whose job was left out", () => {
    const proposal = validated();
    const { library: next, added } = proposalToLibraryAdditions(null, proposal, ["education-0", "job-0-row-0"], { prefix: "abc", name: "Jane Okafor" });

    expect(added).toEqual({ jobs: 0, rows: 0, education: 1, skills: 0 });
    expect(next.employment).toEqual([]);
    expect(next.entries.map(entry => entry.kind)).toEqual(["education"]);
  });

  it("never removes, rewrites or re-confirms what the library already holds", () => {
    const before = library();
    const proposal = validated();
    const { library: next, added } = proposalToLibraryAdditions(before, proposal, proposedItemIds(proposal), { prefix: "abc" });

    // The same job: one employment record, one block, the confirmed row untouched.
    expect(added).toEqual({ jobs: 0, rows: 1, education: 1, skills: 2 });
    expect(next.employment).toHaveLength(1);
    expect(next.employment![0]!.id).toBe("job1");
    const experience = next.entries.filter(entry => entry.kind === "experience");
    expect(experience).toHaveLength(1);
    expect(experience[0]).toMatchObject({ id: "existing", status: "active", confirmedResponsibilities: ["Cut handover time from two days to four hours"] });
    expect(responsibilityRows(experience[0]!.details)).toEqual([
      "Cut handover time from two days to four hours",
      "Ran the UK warehouse team of 30 through a move to a new site",
    ]);
    expect(() => parseLibraryAdditions(next)).not.toThrow();
  });

  it("does not repeat a skill or a qualification the library already carries", () => {
    const before = library({
      entries: [
        { id: "skills", kind: "skill", status: "active", heading: "Skills", details: "Kanban", skillItems: ["Kanban"] },
        { id: "degree", kind: "education", status: "active", heading: "University of Leeds", details: "MSc Operations Management, University of Leeds, 2014" },
      ],
      employment: [],
    });
    const proposal = validated();
    const { library: next, added } = proposalToLibraryAdditions(before, proposal, ["education-0", "skill-0", "skill-1"], { prefix: "abc" });

    expect(added).toMatchObject({ education: 0, skills: 1 });
    expect(next.entries.filter(entry => entry.kind === "education")).toHaveLength(1);
    expect(next.entries.filter(entry => entry.kind === "skill").map(entry => entry.skillItems)).toEqual([["Kanban"], ["S&OP"]]);
  });

  it("accepting nothing changes nothing", () => {
    const before = library();
    const { library: next, added } = proposalToLibraryAdditions(before, validated(), [], { prefix: "abc" });

    expect(added).toEqual({ jobs: 0, rows: 0, education: 0, skills: 0 });
    expect(parseLibraryAdditions(next)).toEqual(parseLibraryAdditions(before));
  });

  it("stops one job at the twenty rows the Library accepts", () => {
    const rows = Array.from({ length: 24 }, (_, index) => `Ran shift ${index + 1} of the night operation`);
    const document = ["Director of Operations, Acme Logistics", ...rows].join("\n");
    const { proposal } = validateLibraryProposal(document, {
      employment: [{
        company: "Acme Logistics", title: "Director of Operations", quote: "Director of Operations, Acme Logistics",
        responsibilities: rows.map(row => ({ text: row, quote: row })),
      }],
      education: [],
      skills: [],
    });

    expect(proposal.employment[0]!.responsibilities).toHaveLength(20);
    const { library: next } = proposalToLibraryAdditions(null, proposal, proposedItemIds(proposal), { prefix: "abc", name: "Jane Okafor" });
    expect(responsibilityRows(next.entries[0]!.details)).toHaveLength(20);
    expect(() => parseLibraryAdditions(next)).not.toThrow();
  });
});
