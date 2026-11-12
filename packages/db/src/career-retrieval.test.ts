import { describe, expect, it } from "vitest";
import { careerRetrievalContextFromRubric, careerRetrievalScores, compileCareerRetrieval, rankCareerEvidence } from "./career-retrieval";

describe("career evidence retrieval", () => {
  it("uses conservative concepts and user priority rank as search signals", () => {
    const context = careerRetrievalContextFromRubric({ caveats: [], requirements: [
      { id: "r1", label: "Line management", quote: "Line management", importance: "essential", category: "experience", rank: 1 },
      { id: "r2", label: "Incident handling", quote: "Incident handling", importance: "desirable", category: "skills", rank: 2 },
      { id: "r3", label: "Work authorisation", quote: "Work authorisation", importance: "essential", category: "logistics" },
    ] });
    expect(context.requirements.map(row => row.id)).toEqual(["r1", "r2"]);
    expect(careerRetrievalScores("Managed six direct reports", "", [], context).coverage[0]).toBeGreaterThan(0);
    expect(careerRetrievalScores("Led incident response exercises", "", [], context).coverage[1]).toBeGreaterThan(0);
    expect(careerRetrievalScores("Managed six direct reports", "", [], context).score)
      .toBeGreaterThan(careerRetrievalScores("Led incident response exercises", "", [], context).score);
  });

  it("recalls complementary evidence when several requirements compete for a cap", () => {
    const context = { version: 1 as const, requirements: [
      { id: "a", text: "budget management", kind: "essential" as const },
      { id: "b", text: "incident response", kind: "essential" as const },
    ] };
    const ranked = rankCareerEvidence([
      "Budget management across all divisions", "Budget management for technology", "Handled incident response",
    ], item => item, "", [], context);
    expect(ranked.slice(0, 2)).toContain("Handled incident response");
  });

  it("treats aliases as ranking hints only and leaves source text untouched", () => {
    const source = "Coordinated six direct reports";
    const context = { version: 1 as const, requirements: [
      { id: "a", text: "Team supervision", kind: "essential" as const, searchHints: ["direct reports"] },
    ] };
    expect(rankCareerEvidence(["Routine reporting", source], item => item, "", [], context)[0]).toBe(source);
    expect(source).not.toContain("Team supervision");
  });

  it("keeps stable weighted order when requirements have no coverage", () => {
    const rows = Array.from({ length: 240 }, (_, index) => ({ id: index,
      text: ["Incident response", "Cyber security", "Budget oversight", "Routine work"][index % 4]!, extra: index % 3 }));
    const context = { version: 1 as const, requirements: [
      { id: "absent", text: "Marine biology", kind: "essential" as const },
    ] };
    const scorer = compileCareerRetrieval("Cybersecurity incident handling", ["budget management"], context);
    const expected = rows.map((row, index) => ({ row, index, score: scorer(row.text).score + row.extra }))
      .sort((a, b) => b.score - a.score || a.index - b.index).map(item => item.row.id);
    const actual = rankCareerEvidence(rows, row => row.text, "Cybersecurity incident handling",
      ["budget management"], context, row => row.extra, scorer).map(row => row.id);
    expect(actual).toEqual(expected);
    for (const row of rows) expect(scorer(row.text)).toEqual(careerRetrievalScores(row.text,
      "Cybersecurity incident handling", ["budget management"], context));
  });

  it("keeps the top essential ahead of several low desirables, then recalls complementary evidence", () => {
    const context = { version: 1 as const, requirements: [
      { id: "lead", text: "line management", kind: "essential" as const, rank: 1 },
      { id: "report", text: "reporting", kind: "desirable" as const, rank: 5 },
      { id: "budget", text: "budget oversight", kind: "desirable" as const, rank: 6 },
    ] };
    const rows = ["Routine task", "Reporting and budget oversight", "Managed six direct reports",
      "Other routine task", "Budget oversight", "Reporting"];
    const ranked = rankCareerEvidence(rows, row => row, "", [], context);
    expect(ranked[0]).toBe("Managed six direct reports");
    expect(ranked[1]).toBe("Reporting and budget oversight");
    expect(ranked.slice(0, 2)).not.toContain("Routine task");
    expect(ranked).toHaveLength(rows.length);
    expect(new Set(ranked).size).toBe(rows.length);
  });
});
