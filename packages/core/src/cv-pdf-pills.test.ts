import PDFDocument from "pdfkit";
import { expect, it, vi } from "vitest";
import { LIBERATION_SANS_REGULAR } from "./fonts/liberation-sans";
import { drawPillRow, measurePillRows, PILL_STYLES } from "./cv-pdf-pills";

const docFor = (font: "Helvetica" | "Arial") => {
  const doc = new PDFDocument();
  if (font === "Arial") doc.registerFont("Arial", Buffer.from(LIBERATION_SANS_REGULAR.replace(/\s+/g, ""), "base64"));
  return doc;
};

it.each(["Helvetica", "Arial"] as const)("measures eighteen ordinary skill labels without spurious wraps in %s", font => {
  const doc = docFor(font);
  const labels = [
    "BI Tools", "SQL", "Power BI", "Excel", "Operations", "Commercial",
    "Technology", "Forecasting", "Reporting", "Risk", "Delivery", "Planning",
    "Budgeting", "Governance", "Leadership", "Analytics", "CRM", "Automation",
  ];
  const rows = measurePillRows(doc, labels, 507, PILL_STYLES.skill, font);
  expect(rows.flatMap(row => row.pills.map(pill => pill.label))).toEqual(labels);
  const oneLine = rows[0]!.pills[0]!.textHeight;
  expect(rows.every(row => row.pills.every(pill => pill.textHeight === oneLine && pill.height === row.height))).toBe(true);
  expect(rows.every(row => row.pills.every(pill => pill.x + pill.width <= 507))).toBe(true);
  doc.end();
});

it("balances a five-plus-one skill wrap without changing industry packing", () => {
  const doc = docFor("Helvetica");
  const labels = ["Planning", "Reporting", "Analysis", "Delivery", "Forecasting", "Governance"];
  const widthForFive = (style: typeof PILL_STYLES.skill | typeof PILL_STYLES.industry) =>
    labels.slice(0, 5).reduce((sum, label) => sum + measurePillRows(doc, [label], 507, style)[0]!.pills[0]!.width, 0) + 4 * style.gapX;
  const balanced = measurePillRows(doc, labels, widthForFive(PILL_STYLES.skill), PILL_STYLES.skill);
  expect(balanced).toHaveLength(2);
  expect(balanced.map(row => row.pills.length)).not.toEqual([5, 1]);
  expect(balanced[1]!.pills.length).toBeGreaterThan(1);
  expect(balanced.flatMap(row => row.pills.map(pill => pill.label))).toEqual(labels);
  const industries = measurePillRows(doc, labels, widthForFive(PILL_STYLES.industry), PILL_STYLES.industry);
  expect(industries.map(row => row.pills.length)).toEqual([5, 1]);
  doc.end();
});

it.each(["Helvetica", "Arial"] as const)("keeps 150-character worded and unbroken labels inside %s pills", font => {
  const doc = docFor(font);
  const labels = [("Enterprise reporting and operating model ".repeat(4)).slice(0, 150), "W".repeat(150)];
  const rows = measurePillRows(doc, labels, 220, PILL_STYLES.skill, font);
  expect(rows.flatMap(row => row.pills.map(pill => pill.label))).toEqual(labels);
  expect(rows).toHaveLength(2);
  expect(rows.every(row => row.pills[0]!.width <= 220 && row.pills[0]!.textHeight > doc.currentLineHeight(true))).toBe(true);
  doc.end();
});

it("draws every pill in a mixed-height row at the row height and centres each label", () => {
  const doc = docFor("Helvetica");
  const rounded = vi.spyOn(doc, "roundedRect");
  const text = vi.spyOn(doc, "text");
  const row = { height: 40, pills: [
    { label: "SQL", x: 0, width: 50, height: 18, textHeight: 10, lineHeight: 12 },
    { label: "Long label", x: 55, width: 120, height: 40, textHeight: 30, lineHeight: 12 },
  ] };
  drawPillRow(doc, row, 44, 100, "#eeeeee", PILL_STYLES.skill);
  expect(rounded.mock.calls.map(call => call[3])).toEqual([40, 40]);
  expect((text.mock.calls as unknown as unknown[][]).map(call => call[2])).toEqual([121, 111]);
  doc.end();
});
