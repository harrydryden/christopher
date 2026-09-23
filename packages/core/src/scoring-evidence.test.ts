import { describe, expect, it } from "vitest";
import { A5_EVIDENCE_TOKENS, scoringEvidence, type ScoringEvidenceBlock } from "./cv-budget";

/**
 * What a fit score (A5) is shown of a person's library: the evidence that bears on the role, not
 * the whole record, and never more than the cap however much the library holds.
 */
describe("scoring evidence", () => {
  const warehouse: ScoringEvidenceBlock = { heading: "Director of Operations · Acme Logistics (experience)", rows: ["Ran the UK warehouse team of 30", "Cut handover time from two days to four hours"] };
  const design: ScoringEvidenceBlock = { heading: "Brand designer · Studio (experience)", rows: ["Designed three brand identities"] };

  it("puts the evidence that shares the role's words first, each row once", () => {
    const text = scoringEvidence([design, { ...warehouse, rows: [...warehouse.rows, warehouse.rows[0]!] }], "Warehouse operations director, logistics");
    expect(text.split("\n")).toEqual([
      warehouse.heading, `- ${warehouse.rows[0]}`, `- ${warehouse.rows[1]}`,
      design.heading, `- ${design.rows[0]}`,
    ]);
  });

  it("stays under its cap for a library of a hundred long entries, and says that it stopped", () => {
    const blocks = Array.from({ length: 100 }, (_, index) => ({
      heading: `Role ${index} (experience)`,
      rows: Array.from({ length: 20 }, (_, row) => `Led operations workstream ${row} `.repeat(20)),
    }));
    const text = scoringEvidence(blocks, "operations");
    expect(text.length).toBeLessThanOrEqual(A5_EVIDENCE_TOKENS * 4 + 30);
    expect(text.endsWith("(more evidence not shown)")).toBe(true);
    // Deterministic, so the scoring fingerprint moves only when the evidence it reads does.
    expect(scoringEvidence(blocks, "operations")).toBe(text);
  });

  it("is unmoved by an edit to evidence the role never sees", () => {
    const filler = Array.from({ length: 40 }, (_, index) => ({ heading: `Warehouse role ${index} (experience)`, rows: ["Ran warehouse operations for a large site ".repeat(8)] }));
    const unrelated = { heading: "Hobbies (interest)", rows: ["Sailing"] };
    const before = scoringEvidence([...filler, unrelated], "warehouse operations", 500);
    const after = scoringEvidence([...filler, { ...unrelated, rows: ["Sailing and climbing"] }], "warehouse operations", 500);
    expect(after).toBe(before);
  });

  it("clips a paragraph-long row rather than letting it crowd out everything else", () => {
    const text = scoringEvidence([{ heading: "Operations lead (experience)", rows: ["Led operations ".repeat(2_600), "Ran the warehouse"] }], "operations");
    expect(text).toContain("- Ran the warehouse");
    expect(text.split("\n")[1]!.length).toBeLessThan(700);
  });

  it("leaves out a block with nothing confirmed in it", () => {
    expect(scoringEvidence([{ heading: "Empty (experience)", rows: [" "] }], "operations")).toBe("");
  });
});
