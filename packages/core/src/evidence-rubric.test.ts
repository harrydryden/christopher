/**
 * The type-specific rubric: four marks a type, the arithmetic that turns marks into a row's score,
 * and the wording rules held to rows whose marks were settled by calibration.
 */
import { describe, expect, it } from "vitest";
import { EVIDENCE_FACETS, type EvidenceFacet } from "./cv";
import {
  EVIDENCE_MARKS,
  EVIDENCE_MARKS_BY_FACET,
  EVIDENCE_MARK_POINTS,
  EVIDENCE_MARK_SPECS,
  detectEvidenceMarks,
  knownEvidenceMarks,
  scoreRowAgainst,
  scoredAsLine,
  type EvidenceMark,
} from "./evidence-rubric";

const scoreOf = (row: string, facets: EvidenceFacet[]) => scoreRowAgainst(detectEvidenceMarks(row), facets).score;

describe("the rubric", () => {
  it("has four marks for each of the six types, a quarter each", () => {
    expect(EVIDENCE_MARKS).toHaveLength(24);
    for (const facet of EVIDENCE_FACETS) {
      expect(EVIDENCE_MARKS_BY_FACET[facet]).toHaveLength(4);
      for (const mark of EVIDENCE_MARKS_BY_FACET[facet]) {
        expect(mark.startsWith(`${facet}.`)).toBe(true);
        expect(EVIDENCE_MARK_SPECS[mark].facet).toBe(facet);
      }
    }
    expect(4 * EVIDENCE_MARK_POINTS).toBe(100);
  });
});

/** For each type: a row that says everything the type needs, and a thin one. From calibration. */
const CALIBRATION: ReadonlyArray<{ facet: EvidenceFacet; strong: string; thin: string; thinScore: number; thinHas: EvidenceMark[] }> = [
  {
    facet: "responsibility",
    strong: "Led FP&A for the UK group: owned the £40m budget and monthly forecast for the CFO and five business units",
    thin: "Responsible for operations", thinScore: 25, thinHas: ["responsibility.ownership"],
  },
  {
    facet: "problem",
    strong: "Month-end close took 10 days because consolidation ran on 30 spreadsheets; rebuilt it in Anaplan and cut close to 6 days",
    thin: "Month-end close took 10 days and relied on 30 spreadsheets", thinScore: 25, thinHas: ["problem.situation"],
  },
  {
    facet: "outcome",
    // An outcome row that names who gained is the full story; the calibration's close row lacks it.
    strong: "Grew ARR from £2m to £5m over 18 months by moving sales to a land-and-expand model",
    thin: "Improved reporting for the business", thinScore: 50, thinHas: ["outcome.change", "outcome.beneficiary"],
  },
  {
    facet: "metric",
    strong: "Grew ARR from £2m to £5m over 18 months by moving sales to a land-and-expand model",
    thin: "Revenue £5m", thinScore: 50, thinHas: ["metric.figure", "metric.measure"],
  },
  {
    facet: "milestone",
    strong: "Launched the new billing platform in March 2024, on time, replacing a legacy system across all four markets",
    thin: "Delivered the project", thinScore: 25, thinHas: ["milestone.role"],
  },
  {
    facet: "style",
    strong: "When the finance and engineering teams disagreed on the data model, I facilitated a workshop that got both to agree a shared schema in a week",
    thin: "Strong communicator and team player", thinScore: 25, thinHas: ["style.counterpart"],
  },
];

describe("detectEvidenceMarks, against the calibration rows", () => {
  for (const { facet, strong, thin, thinScore, thinHas } of CALIBRATION) {
    it(`reads a strong ${facet} row at 100 and a thin one at ${thinScore}`, () => {
      expect(scoreOf(strong, [facet])).toBe(100);
      expect(scoreOf(thin, [facet])).toBe(thinScore);
      expect(scoreOf(thin, [facet])).toBeLessThanOrEqual(thinScore);
      const { byFacet } = scoreRowAgainst(detectEvidenceMarks(thin), [facet]);
      expect(byFacet[0]!.earned).toEqual(thinHas);
      expect(byFacet[0]!.missing).toEqual(EVIDENCE_MARKS_BY_FACET[facet].filter(mark => !thinHas.includes(mark)));
    });
  }

  it("reads the rest of the calibration as calibrated", () => {
    // Scope and audience, but not whose it was or how big.
    expect(scoreOf("FP&A. Growth planning and budgeting for the group", ["responsibility"])).toBe(50);
    // The change, what caused it and its size; nobody named as gaining. As a metric it is complete.
    const close = "Cut month-end close from 10 to 6 days by rebuilding consolidation in Anaplan";
    expect(scoreOf(close, ["outcome"])).toBe(75);
    expect(scoreRowAgainst(detectEvidenceMarks(close), ["outcome"]).byFacet[0]!.missing).toEqual(["outcome.beneficiary"]);
    expect(scoreOf(close, ["metric"])).toBe(100);
    expect(scoreOf(close, ["outcome", "metric"])).toBe(88);
  });

  it("finds nothing in an empty or whitespace row", () => {
    expect(detectEvidenceMarks("")).toEqual([]);
    expect(detectEvidenceMarks("   \n\t ")).toEqual([]);
  });
});

describe("scoreRowAgainst", () => {
  const every = [...EVIDENCE_MARKS];

  it("has no score for a row with no type, whatever its marks", () => {
    expect(scoreRowAgainst(every, [])).toEqual({ score: null, byFacet: [] });
    expect(scoreRowAgainst([], []).score).toBeNull();
  });

  it("gives a quarter a mark against one type, and ignores marks of other types", () => {
    expect(scoreRowAgainst([], ["metric"]).score).toBe(0);
    expect(scoreRowAgainst(["metric.figure"], ["metric"]).score).toBe(25);
    expect(scoreRowAgainst(["metric.figure", "metric.measure", "metric.movement"], ["metric"]).score).toBe(75);
    expect(scoreRowAgainst(["outcome.change", "outcome.cause", "style.effect"], ["metric"]).score).toBe(0);
  });

  it("shows the mean across several types, rounded, in the canonical type order", () => {
    const marks: EvidenceMark[] = ["outcome.change", "outcome.cause", "outcome.magnitude", ...EVIDENCE_MARKS_BY_FACET.metric];
    const scored = scoreRowAgainst(marks, ["metric", "outcome"]);
    // (75 + 100) ÷ 2 = 87.5 → 88.
    expect(scored.score).toBe(88);
    expect(scored.byFacet.map(item => [item.facet, item.score])).toEqual([["outcome", 75], ["metric", 100]]);
    // (25 + 0 + 0) ÷ 3 = 8.33 → 8.
    expect(scoreRowAgainst(["style.behaviour"], ["style", "milestone", "problem"]).score).toBe(8);
    // (50 + 25 + 0) ÷ 3 = 25.
    expect(scoreRowAgainst(["problem.situation", "problem.approach", "milestone.role"], ["problem", "milestone", "style"]).score).toBe(25);
    // A type repeated is one type.
    expect(scoreRowAgainst(["metric.figure"], ["metric", "metric"]).byFacet).toHaveLength(1);
  });
});

describe("knownEvidenceMarks", () => {
  it("keeps only the rubric's marks, each once, in rubric order", () => {
    expect(knownEvidenceMarks(["style.effect", "metric.figure", "vibes", "metric.figure", "responsibility.scope", "metric"]))
      .toEqual(["responsibility.scope", "metric.figure", "style.effect"]);
    expect(knownEvidenceMarks([])).toEqual([]);
    expect(knownEvidenceMarks([...EVIDENCE_MARKS].reverse())).toEqual([...EVIDENCE_MARKS]);
  });
});

describe("scoredAsLine", () => {
  it("names the types in the Type column's words", () => {
    expect(scoredAsLine([])).toBe("");
    expect(scoredAsLine(["metric"])).toBe("Metrics moved");
    expect(scoredAsLine(["metric", "responsibility"])).toBe("Responsibilities and Metrics moved");
  });
});
