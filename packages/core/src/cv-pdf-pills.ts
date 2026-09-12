import type {} from "pdfkit";
import { cvForeground } from "./cv-theme";

export const PILL_STYLES = {
  industry: { fontSize: 8, paddingX: 8, paddingY: 4, gapX: 5, gapY: 4, radius: 7 },
  skill: { fontSize: 9, paddingX: 10, paddingY: 6, gapX: 6, gapY: 6, radius: 11 },
} as const;
type PillStyle = typeof PILL_STYLES[keyof typeof PILL_STYLES];
type Pill = { label: string; x: number; width: number; height: number; textHeight: number; lineHeight: number };
export type PillRow = { pills: Pill[]; height: number };
export const cleanCvText = (value: string) => value.replace(/[\u2010-\u2015]/g, "-").replace(/\s+/g, " ").trim();

/** Measurement and drawing share all font, wrapping and alignment options. */
export function measurePillRows(doc: PDFKit.PDFDocument, labels: string[], width: number, style: PillStyle): PillRow[] {
  const rows: PillRow[] = [];
  let x = 0;
  for (const value of labels) {
    const label = cleanCvText(value);
    doc.font("Helvetica").fontSize(style.fontSize);
    const pillWidth = Math.min(width, doc.widthOfString(label) + style.paddingX * 2);
    const textHeight = doc.heightOfString(label, { width: pillWidth - style.paddingX * 2, lineGap: 1 });
    const height = textHeight + style.paddingY * 2;
    if (!rows.length || (x && x + pillWidth > width)) { rows.push({ pills: [], height: 0 }); x = 0; }
    const row = rows[rows.length - 1]!;
    row.pills.push({ label, x, width: pillWidth, height, textHeight, lineHeight: doc.currentLineHeight(true) + 1 });
    row.height = Math.max(row.height, height);
    x += pillWidth + style.gapX;
  }
  return rows;
}
export function drawPillRow(doc: PDFKit.PDFDocument, row: PillRow, left: number, top: number, colour: string, style: PillStyle): void {
  for (const pill of row.pills) {
    doc.roundedRect(left + pill.x, top, pill.width, pill.height, style.radius).fill(colour);
    // Reset the font even after a page break/continuation heading.
    doc.font("Helvetica").fontSize(style.fontSize).fillColor(cvForeground(colour)).text(pill.label,
      left + pill.x + style.paddingX, top + (pill.height - pill.textHeight + pill.lineHeight) / 2,
      { width: pill.width - style.paddingX * 2, lineGap: 1, align: "center", baseline: "middle" });
  }
}
