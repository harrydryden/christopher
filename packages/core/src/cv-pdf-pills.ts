import type {} from "pdfkit";
import { cvForeground } from "./cv-theme";

export const PILL_STYLES = {
  industry: { fontSize: 8, paddingX: 8, paddingY: 4, gapX: 5, gapY: 4, radius: 7 },
  skill: { fontSize: 8.5, paddingX: 6, paddingY: 3, gapX: 5, gapY: 4, radius: 8 },
} as const;
type PillStyle = (typeof PILL_STYLES)[keyof typeof PILL_STYLES];
type Pill = { label: string; x: number; width: number; height: number; textHeight: number; lineHeight: number; heading: boolean };
export type PillRow = { pills: Pill[]; height: number };
const HEADING_TIP_WIDTH = 5;
type HeadingPill = { label: string; font: string };
import { cleanCvText } from "./cv-format";
export { cleanCvText } from "./cv-format";

/** Preserve the chosen pill hue while giving a section pill a visibly stronger fill. */
export function darkerPillColour(colour: string): string {
  return `#${[1, 3, 5].map(index => Math.round(Number.parseInt(colour.slice(index, index + 2), 16) * 0.72)
    .toString(16).padStart(2, "0")).join("")}`;
}

/** Measurement and drawing share all font, wrapping and alignment options. */
export function measurePillRows(doc: PDFKit.PDFDocument, labels: string[], width: number, style: PillStyle, font = "Helvetica", heading?: HeadingPill): PillRow[] {
  // PDFKit may wrap text measured to its exact width because drawing rounds glyph positions.
  // One point of breathing room keeps short labels on one line in either embedded font.
  const pills = [...(heading ? [{ value: heading.label, face: heading.font, isHeading: true }] : []),
    ...labels.map(value => ({ value, face: font, isHeading: false }))].map(({ value, face, isHeading }) => {
    const label = cleanCvText(value);
    doc.font(face).fontSize(style.fontSize);
    const pillWidth = Math.min(width, Math.ceil(doc.widthOfString(label) + style.paddingX * 2 + 1 + (isHeading ? HEADING_TIP_WIDTH : 0)));
    const textWidth = pillWidth - style.paddingX * 2 - (isHeading ? HEADING_TIP_WIDTH : 0);
    const textHeight = doc.heightOfString(label, { width: textWidth, lineGap: 1, align: "center", baseline: "middle" });
    return { label, x: 0, width: pillWidth, height: Math.ceil(textHeight + style.paddingY * 2), textHeight,
      lineHeight: doc.currentLineHeight(true) + 1, heading: isHeading };
  });
  if (style === PILL_STYLES.skill && heading) {
    // Bold and regular faces differ slightly in ascent. Give every ordinary pill the same
    // minimum height, even when a row contains no heading pill.
    const oneLine = [font, heading.font].map(face => {
      doc.font(face).fontSize(style.fontSize);
      return doc.heightOfString("Mg", { width: width - style.paddingX * 2, lineGap: 1, align: "center", baseline: "middle" });
    });
    const minimumHeight = Math.ceil(Math.max(...oneLine) + style.paddingY * 2);
    for (const pill of pills) pill.height = Math.max(pill.height, minimumHeight);
  }
  const rows: PillRow[] = [];
  const rowFor = (first: number, last: number): PillRow => {
    const items = pills.slice(first, last);
    const height = Math.max(...items.map(pill => pill.height));
    let x = 0;
    return { pills: items.map(pill => {
      const placed = { ...pill, x, height };
      x += pill.width + style.gapX;
      return placed;
    }), height };
  };
  // Fill each row in source order before wrapping the next pill.
  let first = 0;
  let used = 0;
  for (let index = 0; index < pills.length; index++) {
    const next = used ? used + style.gapX + pills[index]!.width : pills[index]!.width;
    if (used && next > width) { rows.push(rowFor(first, index)); first = index; used = 0; }
    used = used ? used + style.gapX + pills[index]!.width : pills[index]!.width;
  }
  if (first < pills.length) rows.push(rowFor(first, pills.length));
  return rows;
}
export function drawPillRow(doc: PDFKit.PDFDocument, row: PillRow, left: number, top: number, colour: string, style: PillStyle, font = "Helvetica", heading?: { colour: string; font: string }): void {
  for (const pill of row.pills) {
    const fill = pill.heading ? heading?.colour ?? darkerPillColour(colour) : colour;
    if (pill.heading) {
      const x = left + pill.x;
      const right = x + pill.width;
      doc.save().moveTo(x, top).lineTo(right - HEADING_TIP_WIDTH, top)
        .lineTo(right, top + row.height / 2).lineTo(right - HEADING_TIP_WIDTH, top + row.height)
        .lineTo(x, top + row.height).closePath().clip();
    }
    doc.roundedRect(left + pill.x, top, pill.width, row.height, style.radius).fill(fill);
    if (pill.heading) doc.restore();
    // Reset the font even after a page break/continuation heading.
    doc.font(pill.heading ? heading?.font ?? font : font).fontSize(style.fontSize).fillColor(cvForeground(fill)).text(pill.label,
      left + pill.x + style.paddingX, top + (row.height - pill.textHeight + pill.lineHeight) / 2,
      { width: pill.width - style.paddingX * 2 - (pill.heading ? HEADING_TIP_WIDTH : 0), lineGap: 1, align: "center", baseline: "middle" });
  }
}
