import PDFDocument from "pdfkit";
import { cvForeground, cvDisplaySections, type CvContent } from "@christopher/core/cv";

/** Server-side, selectable-text A4 PDF. No browser, remote fonts or model-authored HTML. */
export async function renderCvPdf(content: CvContent): Promise<Buffer> {
  return (await renderCvPdfWithReport(content)).pdf;
}

export async function renderCvPdfWithReport(content: CvContent): Promise<{ pdf: Buffer; pageCount: number }> {
  const doc = new PDFDocument({ size: "A4", margin: 44, bufferPages: true, info: { Title: `${content.name} - CV`, Author: content.name } });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => { doc.on("data", chunk => chunks.push(chunk)); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject); });
  const theme = content.theme;
  const ink = theme ? cvForeground(theme.background) : "#263244";
  const accent = theme?.primary ?? "#16243d";
  const paintPage = () => {
    if (!theme) return;
    doc.save().rect(0, 0, doc.page.width, doc.page.height).fill(theme.background);
    doc.restore();
  };
  paintPage(); doc.on("pageAdded", paintPage);
  const width = doc.page.width - 88;
  const clean = (text: string) => text.replace(/[\u2010-\u2015]/g, "-").replace(/\s+/g, " ").trim();
  const text = (value: string, bold = false, size = 10) => { doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(theme ? ink : bold ? "#16243d" : "#263244").text(clean(value), { width, lineGap: 2.5 }); };
  const room = (height: number) => { if (doc.y + height > doc.page.height - 55) doc.addPage(); };
  const heading = (value: string) => {
    room(80);
    if (theme) {
      const top = doc.y + 10;
      const label = value.toUpperCase();
      doc.font("Helvetica-Bold").fontSize(11);
      doc.fillColor(ink).text(label, 44, top, { width, lineGap: 0 });
      const underlineTop = doc.y + 3;
      doc.rect(44, underlineTop, width, 3).fill(accent);
      doc.x = 44; doc.y = underlineTop + 16;
    } else {
      doc.moveDown(0.7); text(value.toUpperCase(), true, 11);
      doc.moveTo(44, doc.y + 2).lineTo(doc.page.width - 44, doc.y + 2).strokeColor(accent).lineWidth(0.6).stroke(); doc.moveDown(0.65);
    }
  };
  const contact = clean(content.contact).replace(/\s+/g, " ").trim();
  const drawContact = (colour: string) => {
    doc.font("Helvetica").fontSize(9).fillColor(colour);
    if (content.linkedinUrl) {
      if (contact) doc.text(`${contact} · `, { width, lineGap: 2.5, continued: true });
      doc.text("LinkedIn", { link: content.linkedinUrl, underline: true, width, lineGap: 2.5, continued: false });
    } else if (contact) doc.text(contact, { width, lineGap: 2.5 });
  };
  if (theme) {
    // Measure before painting so the coloured masthead grows with the actual content.
    doc.font("Helvetica-Bold").fontSize(22);
    const nameHeight = doc.heightOfString(clean(content.name), { width, lineGap: 2.5 });
    doc.font("Helvetica").fontSize(9);
    const contactText = [contact, content.linkedinUrl ? "LinkedIn" : ""].filter(Boolean).join(" · ");
    const contactHeight = contactText ? doc.heightOfString(contactText, { width, lineGap: 2.5 }) : 0;
    const contactTop = 34 + nameHeight + 14;
    const profileTop = contactTop + contactHeight + 20;
    const profileWidth = theme.introPanel ? width - 110 : width;
    doc.font("Helvetica").fontSize(10);
    const summaryHeight = doc.heightOfString(clean(content.summary), { width: profileWidth, lineGap: 2.5 });
    const profileHeight = Math.max(20, summaryHeight) + 28;
    const headerBottom = profileTop + profileHeight + 22;
    doc.rect(0, 0, doc.page.width, headerBottom).fill(accent);
    const headerInk = cvForeground(accent);
    doc.font("Helvetica-Bold").fontSize(22).fillColor(headerInk).text(clean(content.name), 44, 34, { width, lineGap: 2.5 });
    doc.x = 44; doc.y = contactTop; drawContact(headerInk);
    if (theme.introPanel) {
      doc.roundedRect(44, profileTop, width, profileHeight, 12).fill(theme.surface);
      const panelInk = cvForeground(theme.surface);
      doc.font("Helvetica-Bold").fontSize(10).fillColor(panelInk).text("Profile", 60, profileTop + 14, { width: 62 });
      doc.moveTo(130, profileTop + 12).lineTo(130, profileTop + profileHeight - 12).lineWidth(0.5).strokeColor(panelInk).stroke();
      doc.font("Helvetica").fontSize(10).fillColor(panelInk).text(clean(content.summary), 144, profileTop + 14, { width: profileWidth, lineGap: 2.5 });
    } else {
      doc.font("Helvetica").fontSize(10).fillColor(headerInk).text(clean(content.summary), 44, profileTop + 14, { width, lineGap: 2.5 });
    }
    doc.x = 44; doc.y = headerBottom + 8;
  } else {
    text(content.name.toUpperCase(), true, 22); doc.moveDown(0.3);
    drawContact(ink); doc.moveDown(0.5); heading("Profile"); text(content.summary);
  }
  const groups = [["experience", "Work experience"], ["education", "Education and Skills"], ["interest", "Interests"]] as const;
  for (const [kind, title] of groups) {
    const sections = cvDisplaySections(content).map(item => item.section).filter(s => s.kind === kind || kind === "education" && s.kind === "skill");
    if (!sections.length) continue;
    heading(title);
    for (const section of sections) {
      const sectionHeading = section.kind === "skill" ? "Skill" : section.heading;
      doc.font("Helvetica-Bold").fontSize(10);
      const headerHeight = doc.heightOfString(clean(sectionHeading), { width, lineGap: 2.5 });
      doc.font("Helvetica");
      const firstHeight = doc.heightOfString(clean(section.bullets[0] ?? ""), { width: width - 12, lineGap: 2.5 });
      const industries = section.industryDescriptions?.join(" · ");
      doc.fontSize(9);
      const industryHeight = industries ? doc.heightOfString(clean(industries), { width, lineGap: 2.5 }) + 4 : 0;
      room(headerHeight + industryHeight + firstHeight + 18);
      text(sectionHeading, true); doc.moveDown(0.25);
      if (industries) { text(industries, false, 9); doc.moveDown(0.25); }
      if (section.kind === "skill" && section.skillItems?.length && theme?.skillPills) {
        let x = 44;
        let rowTop = doc.y;
        let rowHeight = 0;
        for (const skill of section.skillItems) {
          doc.font("Helvetica").fontSize(9);
          const pillWidth = Math.min(width, doc.widthOfString(clean(skill)) + 20);
          const pillHeight = doc.heightOfString(clean(skill), { width: pillWidth - 20, lineGap: 1 }) + 12;
          if (x > 44 && x + pillWidth > 44 + width) { rowTop += rowHeight + 6; x = 44; rowHeight = 0; }
          if (rowTop + pillHeight > doc.page.height - 55) {
            doc.addPage(); text(`${sectionHeading} (continued)`, true); doc.moveDown(0.3);
            rowTop = doc.y; x = 44; rowHeight = 0;
          }
          doc.roundedRect(x, rowTop, pillWidth, pillHeight, Math.min(11, pillHeight / 2)).fill(theme.pill);
          doc.fillColor(cvForeground(theme.pill)).text(clean(skill), x + 10, rowTop + 6, { width: pillWidth - 20, lineGap: 1 });
          x += pillWidth + 6; rowHeight = Math.max(rowHeight, pillHeight);
        }
        doc.x = 44; doc.y = rowTop + rowHeight + 8;
      } else for (const bullet of section.skillItems ?? section.bullets) {
        doc.font("Helvetica").fontSize(10);
        const height = doc.heightOfString(clean(bullet), { width: width - 12, lineGap: 2.5 });
        if (theme && doc.y + height + 5 > doc.page.height - 55) {
          doc.addPage(); text(`${sectionHeading} (continued)`, true); doc.moveDown(0.3);
        } else room(height + 5);
        doc.font("Helvetica").fontSize(10).fillColor(ink);
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
    doc.font("Helvetica").fontSize(8).fillColor(theme ? ink : "#6b7280").text(`${i + 1} / ${range.count}`, 44, doc.page.height - 30, { width, align: "right", lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return { pdf: await result, pageCount: range.count };
}
