/** Minimal CSV writer (RFC 4180 quoting). */

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
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
