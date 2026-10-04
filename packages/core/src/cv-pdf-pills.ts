import type {} from "pdfkit";
import { cvForeground } from "./cv-theme";

export const PILL_STYLES = {
  industry: { fontSize: 8, paddingX: 8, paddingY: 4, gapX: 5, gapY: 4, radius: 7 },
  skill: { fontSize: 8.5, paddingX: 6, paddingY: 3, gapX: 5, gapY: 4, radius: 8 },
} as const;
type PillStyle = (typeof PILL_STYLES)[keyof typeof PILL_STYLES];
type Pill = { label: string; x: number; width: number; height: number; textHeight: number; lineHeight: number };
export type PillRow = { pills: Pill[]; height: number };
import { cleanCvText } from "./cv-format";
export { cleanCvText } from "./cv-format";

/** Measurement and drawing share all font, wrapping and alignment options. */
export function measurePillRows(doc: PDFKit.PDFDocument, labels: string[], width: number, style: PillStyle, font = "Helvetica"): PillRow[] {
  // PDFKit may wrap text measured to its exact width because drawing rounds glyph positions.
  // One point of breathing room keeps short labels on one line in either embedded font.
  const pills = labels.map(value => {
    const label = cleanCvText(value);
    doc.font(font).fontSize(style.fontSize);
    const pillWidth = Math.min(width, Math.ceil(doc.widthOfString(label) + style.paddingX * 2 + 1));
    const textWidth = pillWidth - style.paddingX * 2;
    const textHeight = doc.heightOfString(label, { width: textWidth, lineGap: 1, align: "center", baseline: "middle" });
    return { label, x: 0, width: pillWidth, height: Math.ceil(textHeight + style.paddingY * 2), textHeight,
      lineHeight: doc.currentLineHeight(true) + 1 };
  });
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
  if (style !== PILL_STYLES.skill) {
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
  // Dynamic programming keeps the minimum rendered height and row count, then chooses the
  // least ragged order-preserving breaks. A final singleton loses to a balanced split when both fit.
  type Layout = { height: number; count: number; singleton: number; raggedness: number; end: number };
  const best: Layout[] = Array(pills.length + 1);
  best[pills.length] = { height: 0, count: 0, singleton: 0, raggedness: 0, end: pills.length };
  for (let first = pills.length - 1; first >= 0; first--) {
    let used = 0;
    let rowHeight = 0;
    for (let end = first + 1; end <= pills.length; end++) {
      const pill = pills[end - 1]!;
      used += (end > first + 1 ? style.gapX : 0) + pill.width;
      if (used > width) break;
      rowHeight = Math.max(rowHeight, pill.height);
      const tail = best[end]!;
      const candidate: Layout = {
        height: rowHeight + (tail.count ? style.gapY + tail.height : 0),
        count: 1 + tail.count,
        singleton: tail.singleton + (end === pills.length && end - first === 1 && first > 0 ? 1 : 0),
        raggedness: tail.raggedness + (width - used) ** 2,
        end,
      };
      const current = best[first];
      if (!current || candidate.height < current.height - 0.01 ||
          (Math.abs(candidate.height - current.height) <= 0.01 &&
            (candidate.count < current.count ||
              (candidate.count === current.count &&
                (candidate.singleton < current.singleton ||
                  (candidate.singleton === current.singleton && candidate.raggedness < current.raggedness))))))
        best[first] = candidate;
    }
  }
  for (let first = 0; first < pills.length;) {
    const end = best[first]!.end;
    rows.push(rowFor(first, end));
    first = end;
  }
  return rows;
}
export function drawPillRow(doc: PDFKit.PDFDocument, row: PillRow, left: number, top: number, colour: string, style: PillStyle, font = "Helvetica"): void {
  for (const pill of row.pills) {
    doc.roundedRect(left + pill.x, top, pill.width, row.height, style.radius).fill(colour);
    // Reset the font even after a page break/continuation heading.
    doc.font(font).fontSize(style.fontSize).fillColor(cvForeground(colour)).text(pill.label,
      left + pill.x + style.paddingX, top + (row.height - pill.textHeight + pill.lineHeight) / 2,
      { width: pill.width - style.paddingX * 2, lineGap: 1, align: "center", baseline: "middle" });
  }
}
