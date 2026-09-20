import { describe, expect, it } from "vitest";
import type { CvAssessment } from "@christopher/core/cv-assessment";
import { materialiseCv, type CvLibrary } from "@christopher/core/cv";
import {
  cvClaimItems,
  cvTextItems,
  cvEvidenceItems,
} from "@christopher/core/cv-assessment";
import { createCvAssessment } from "@christopher/core/cv-review";
import {
  rubricFixture,
  reviewFixture,
} from "../../../packages/core/test/cv-review-fixture";
import { CV_CHANGE_TYPES, cvCommentRows, cvEvaluationRows, libraryDriftSentence } from "./cv-evaluation";
import { CV_PROFILE_ID, cvSectionBlockId } from "./cv-content-links";
const library: CvLibrary = {
  name: "Example",
  contact: "",
  profile: "Operations leader",
  entries: [
    {
      id: "job",
      kind: "experience",
      heading: "Director",
      details: "Led a team",
      confirmedResponsibilities: ["Led a team"],
    },
  ],
};
const content = materialiseCv(library, {
  summary: "Operations leader",
  sections: [{ entryId: "job", bullets: ["Led a team"] }],
  gaps: [],
});
function fixture(): CvAssessment {
  const rubric = rubricFixture("Lead a team");
  const review = reviewFixture({
    rubric,
    cv: cvTextItems(content),
    claims: cvClaimItems(content),
    evidence: cvEvidenceItems(library),
  });
  return createCvAssessment({
    content,
    description: "Lead a team",
    library,
    rubric,
    review,
    model: "test",
    pageCount: 2,
  });
}
describe("unified CV evaluation", () => {
  it.each([
    ["demonstrated", "demonstrated", "None", "Strong", "Strong"],
    ["partial", "partial", "Gap", "Good", "Good"],
    ["missing", "demonstrated", "Improvement", "Strong", "None"],
    ["unknown", "unknown", "Uncertain", "Weak", "Weak"],
    ["unknown", "demonstrated", "Improvement", "Strong", "Weak"],
  ] as const)(
    "maps %s CV / %s library coverage without inventing a score",
    (status, libraryStatus, change, evidence, experience) => {
      const assessment = fixture();
      Object.assign(assessment.review.matches[0]!, { status, libraryStatus });
      const before = JSON.stringify(assessment);
      expect(cvEvaluationRows(assessment, content)[0]).toMatchObject({
        change,
        evidence,
        experience,
        category: "experience",
      });
      expect(JSON.stringify(assessment)).toBe(before);
    },
  );
  it("does not give Strong to uncertain or unsupported wording, even if the model calls it demonstrated", () => {
    for (const [status, change, experience] of [
      ["unsupported", "Fact", "None"],
      ["uncertain", "Uncertain", "Weak"],
    ] as const) {
      const assessment = fixture();
      Object.assign(assessment.review.claims[0]!, {
        status,
        reason: "Confirm the scope.",
      });
      const rows = cvEvaluationRows(assessment, content);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        change,
        experience,
        currentText: [content.summary],
      });
      expect(rows[0]!.suggestion).toContain("item 2");
      expect(rows[1]!.suggestion).toContain("Confirm the scope.");
    }
  });
  it("keeps uncited factual concerns and writing gaps in the same table", () => {
    const assessment = fixture();
    Object.assign(assessment.review.claims[1]!, {
      status: "unsupported",
      reason: "Team size is not confirmed.",
      evidence: [],
    });
    const rows = cvEvaluationRows(assessment, {
      ...content,
      gaps: ["Provide team size.", "Provide team size."],
    });
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({
      requirement: "Factual accuracy",
      change: "Fact",
      evidence: "None",
      currentText: ["Led a team"],
    });
    expect(rows[2]).toMatchObject({
      change: "Gap",
      suggestion: "Provide team size.",
    });
  });
  it("handles absent requirement/claim reviews conservatively", () => {
    const assessment = fixture();
    assessment.review.claims = [];
    expect(cvEvaluationRows(assessment, content)[0]).toMatchObject({
      change: "Uncertain",
      experience: "Weak",
    });
    assessment.review.matches = [];
    expect(cvEvaluationRows(assessment, content)[0]).toMatchObject({
      change: "Uncertain",
      evidence: "None",
      experience: "Weak",
    });
  });
  it("does not show library support without cited evidence", () => {
    const assessment = fixture();
    assessment.review.matches[0]!.libraryEvidence = [];
    expect(cvEvaluationRows(assessment, content)[0]!.evidence).toBe("None");
  });
});

/**
 * A gap names what is missing; these are the rows that also offer the way to supply it (4.3). The
 * link is the Library with the need quoted, and the job it belongs to when the row cites one.
 */
describe("closing a gap from the evaluation table", () => {
  const employed: CvLibrary = {
    name: "Example",
    contact: "",
    profile: "Operations leader",
    employment: [
      { id: "emp-1", company: "Northwind", jobTitle: "Head of Operations", industryDescriptions: "", startDate: "2020-01", endDate: "", current: true },
    ],
    entries: [
      {
        id: "job",
        kind: "experience",
        employmentId: "emp-1",
        heading: "Head of Operations · Northwind",
        details: "Led a team",
        confirmedResponsibilities: ["Led a team"],
      },
    ],
  };
  const employedContent = materialiseCv(employed, {
    summary: "Operations leader",
    sections: [{ entryId: "job", bullets: ["Led a team"] }],
    gaps: [],
  });

  it("offers the Library on gaps and on thin evidence, and nowhere else", () => {
    for (const [status, libraryStatus, offered] of [
      ["partial", "partial", true],      // Gap
      ["unknown", "unknown", true],      // Weak library evidence
      ["demonstrated", "demonstrated", false], // Nothing missing
      ["missing", "demonstrated", false],      // The writer's job, not the Library's
    ] as const) {
      const assessment = fixture();
      Object.assign(assessment.review.matches[0]!, { status, libraryStatus });
      const row = cvEvaluationRows(assessment, content, library)[0]!;
      expect(!!row.libraryHref).toBe(offered);
      if (offered) expect(row.libraryHref).toBe("/library?need=Relevant%20operations%20experience");
    }
  });

  it("names the Library job when the row cites one, and no job when it cites none", () => {
    const assessment = fixture();
    Object.assign(assessment.review.matches[0]!, { status: "partial", libraryStatus: "partial" });
    const cited = cvEvaluationRows(assessment, employedContent, employed)[0]!;
    expect(cited.libraryHref).toBe("/library?need=Relevant%20operations%20experience&job=emp-1");
    // The same row against a Library whose entries belong to no employment record: need only.
    expect(cvEvaluationRows(assessment, content, library)[0]!.libraryHref).not.toContain("&job=");
    // And with no Library to resolve against at all.
    expect(cvEvaluationRows(assessment, employedContent)[0]!.libraryHref).not.toContain("&job=");
  });

  it("quotes the writer's own gap, encoded and cut to 300 characters", () => {
    const assessment = fixture();
    const gap = `${"Evidence of board-level reporting. ".repeat(20)}`;
    const rows = cvEvaluationRows(assessment, { ...content, gaps: [gap] }, library);
    const written = rows.at(-1)!;
    expect(written.change).toBe("Gap");
    const need = new URL(written.libraryHref!, "https://example.test").searchParams.get("need");
    expect(need).toBe(gap.slice(0, 300));
    expect(need!.length).toBe(300);
    expect(written.libraryHref).not.toContain(" ");
  });

  it("says when the Library has moved on since the build, and stays quiet when it has not", () => {
    expect(libraryDriftSentence(7, 9)).toBe("Your Library changed since this build (v7 → v9).");
    expect(libraryDriftSentence(9, 9)).toBeNull();
    expect(libraryDriftSentence(9, 7)).toBeNull();
    expect(libraryDriftSentence(null, 9)).toBeNull();
    expect(libraryDriftSentence(4, undefined)).toBeNull();
  });
});

/**
 * A reader's note in the reviewer's table. It is the only row type that is not the assessment's:
 * it rates nothing, it closes nothing, and it must not be mistaken for a gap.
 */
describe("reader comments as rows", () => {
  const at = (iso: string) => new Date(iso);
  const note = (over: Partial<Parameters<typeof cvCommentRows>[0][number]> = {}) => ({
    id: "note-1",
    anchor: CV_PROFILE_ID,
    authorName: "Sam",
    body: "The profile buries the operations work.",
    createdAt: at("2026-09-18T10:00:00.000Z"),
    resolvedAt: null,
    ...over,
  });

  it("is one of the change types the table filters by", () => {
    expect(CV_CHANGE_TYPES).toContain("Comment");
  });

  it("makes one row per block, carrying the count and the latest note", () => {
    const rows = cvCommentRows(
      [
        note(),
        note({ id: "note-2", body: "And say what it delivered.", createdAt: at("2026-09-19T09:00:00.000Z") }),
        note({ id: "note-3", anchor: cvSectionBlockId("job"), authorName: "Jo", body: "Name the team size.", createdAt: at("2026-09-17T10:00:00.000Z") }),
      ],
      content,
    );
    expect(rows.map((row) => row.id)).toEqual([`comment:${CV_PROFILE_ID}`, `comment:${cvSectionBlockId("job")}`]);
    const profile = rows[0]!;
    expect(profile.change).toBe("Comment");
    expect(profile.requirement).toBe("Profile");
    expect(profile.suggestion).toContain("2 open notes");
    expect(profile.suggestion).toContain("Sam: And say what it delivered.");
    // The earlier note is still readable, under the row's own disclosure.
    expect(profile.sources).toEqual(["Sam: The profile buries the operations work."]);
    expect(profile.contentLinks).toEqual([{ id: CV_PROFILE_ID, label: "Profile" }]);
  });

  it("leaves out the notes the owner has dealt with", () => {
    expect(cvCommentRows([note({ resolvedAt: at("2026-09-19T12:00:00.000Z") })], content)).toEqual([]);
    expect(cvCommentRows([], content)).toEqual([]);
  });

  it("never sends a comment to the Library, however empty its ratings are", () => {
    const [row] = cvCommentRows([note()], content);
    expect(row!.evidence).toBe("None");
    expect(row!.experience).toBe("None");
    expect(row!.libraryHref).toBeUndefined();
  });

  it("appends comments to the assessment's own rows without disturbing them", () => {
    const assessment = fixture();
    const before = cvEvaluationRows(assessment, content, library);
    const after = cvEvaluationRows(assessment, content, library, [note()]);
    expect(after).toHaveLength(before.length + 1);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.at(-1)!.change).toBe("Comment");
    // The row survives the "way out of a gap" pass that every other row goes through.
    expect(after.at(-1)!.libraryHref).toBeUndefined();
  });
});
