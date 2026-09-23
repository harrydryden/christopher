/** Minimal CSV writer (RFC 4180 quoting). */

/**
 * A cell a spreadsheet would read as a formula. Titles, locations and URLs come from third-party
 * careers pages, so a hostile board could plant `=HYPERLINK(...)` in a job title and have it run in
 * the spreadsheet of everyone who follows the company. OWASP's rule: a single quote in front of any
 * text cell that starts with one of these, so it arrives as text.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  // A number is written as a number, so a negative one stays one; only text can carry a formula.
  const s = typeof value !== "number" && FORMULA_START.test(raw) ? `'${raw}` : raw;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(",");
}

export function toCsv(header: string[], rows: unknown[][]): string {
  const lines = [csvRow(header), ...rows.map(csvRow)];
  return lines.join("\r\n") + "\r\n";
}
