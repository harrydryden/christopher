import PDFDocument from "pdfkit";
import type { CvContent } from "@christopher/core";

/** Server-side, selectable-text A4 PDF. No browser, remote fonts or model-authored HTML. */
export async function renderCvPdf(content: CvContent): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 44, bufferPages: true, info: { Title: `${content.name} - CV`, Author: content.name } });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => { doc.on("data", chunk => chunks.push(chunk)); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject); });
  const width = doc.page.width - 88;
  const clean = (text: string) => text.replace(/[\u2010-\u2015]/g, "-").replace(/\u202f|\u00a0/g, " ");
  const text = (value: string, bold = false, size = 10) => { doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(bold ? "#16243d" : "#263244").text(clean(value), { width, lineGap: 2.5 }); };
  const room = (height: number) => { if (doc.y + height > doc.page.height - 55) doc.addPage(); };
  const heading = (value: string) => { room(65); doc.moveDown(0.7); text(value.toUpperCase(), true, 11); doc.moveTo(44, doc.y + 2).lineTo(doc.page.width - 44, doc.y + 2).strokeColor("#16243d").lineWidth(0.6).stroke(); doc.moveDown(0.65); };
  text(content.name.toUpperCase(), true, 22); doc.moveDown(0.3); text(content.contact, false, 9); doc.moveDown(0.5);
  heading("Profile"); text(content.summary);
  const groups = [["experience", "Work experience"], ["skill", "Skills"], ["education", "Education & certifications"], ["interest", "Interests"]] as const;
  for (const [kind, title] of groups) {
    const sections = content.sections.filter(s => s.kind === kind);
    if (!sections.length) continue;
    heading(title);
    for (const section of sections) {
      doc.font("Helvetica-Bold").fontSize(10);
      const headerHeight = doc.heightOfString(clean(section.heading), { width, lineGap: 2.5 });
      doc.font("Helvetica");
      const firstHeight = doc.heightOfString(clean(section.bullets[0] ?? ""), { width: width - 12, lineGap: 2.5 });
      room(headerHeight + firstHeight + 18);
      text(section.heading, true); doc.moveDown(0.25);
      for (const bullet of section.bullets) {
        doc.font("Helvetica").fontSize(10);
        const height = doc.heightOfString(clean(bullet), { width: width - 12, lineGap: 2.5 });
        room(height + 5);
        const y = doc.y;
        doc.text("•", 44, y, { width: 10 });
        doc.text(clean(bullet), 56, y, { width: width - 12, lineGap: 2.5 });
        doc.x = 44; doc.moveDown(0.3);
      }
      doc.moveDown(0.45);
    }
  }
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Reserve footer space without triggering another automatic page.
    const bottom = doc.page.margins.bottom; doc.page.margins.bottom = 0;
    doc.font("Helvetica").fontSize(8).fillColor("#6b7280").text(`${i + 1} / ${range.count}`, 44, doc.page.height - 30, { width, align: "right", lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return result;
}
