import PDFDocument from "pdfkit";
import { DEFAULT_CV_THEME, cvForeground, cvDisplaySections, CvContentSchema, CV_LIMITS, CV_GROUPS, type CvContent } from "./cv";

import { cleanCvText, measurePillRows, drawPillRow, PILL_STYLES } from "./cv-pdf-pills";

export const CV_MAX_PAGES = CV_LIMITS.pages;
export class CvLayoutError extends Error {}
export function assertCvPageLimit(pageCount: number): void {
  if (pageCount > CV_MAX_PAGES) throw new CvLayoutError(`CV is ${pageCount} pages; the maximum is ${CV_MAX_PAGES}. Shorten the profile and bullets, then preview again. No content has been clipped.`);
}

/** Server-side, selectable-text A4 PDF. No browser, remote fonts or model-authored HTML. */
export async function renderCvPdf(content: CvContent): Promise<Buffer> {
  const result = await renderCvPdfWithReport(content);
  assertCvPageLimit(result.pageCount);
  return result.pdf;
}

export async function renderCvPdfWithReport(content: CvContent): Promise<{ pdf: Buffer; pageCount: number }> {
  content = CvContentSchema.parse(content);
  const doc = new PDFDocument({ size: "A4", margin: 44, bufferPages: true, info: { Title: `${content.name} - CV`, Author: content.name } });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => { doc.on("data", chunk => chunks.push(chunk)); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject); });
  const theme = content.theme ?? DEFAULT_CV_THEME;
  const ink = cvForeground(theme.background);
  const accent = theme.primary;
  const paintPage = () => {
    doc.save().rect(0, 0, doc.page.width, doc.page.height).fill(theme.background);
    doc.restore();
  };
  paintPage(); doc.on("pageAdded", paintPage);
  const width = doc.page.width - 88;
  const clean = cleanCvText;
  const text = (value: string, bold = false, size = 10) => { doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(ink).text(clean(value), { width, lineGap: 2.5 }); };
  const room = (height: number) => { if (doc.y + height > doc.page.height - 55) doc.addPage(); };
  const heading = (value: string, followingHeight: number) => {
    doc.font("Helvetica-Bold").fontSize(11);
    room(doc.heightOfString(value.toUpperCase(), { width, lineGap: 0 }) + 29 + followingHeight);
    {
      const top = doc.y + 10;
      const label = value.toUpperCase();
      doc.font("Helvetica-Bold").fontSize(11);
      doc.fillColor(ink).text(label, 44, top, { width, lineGap: 0 });
      const underlineTop = doc.y + 3;
      doc.rect(44, underlineTop, width, 3).fill(accent);
      doc.x = 44; doc.y = underlineTop + 16;
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
  {
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
    if (headerBottom > doc.page.height - 55) throw new CvLayoutError("The name, contact details and profile exceed one page. Shorten the profile before rendering.");
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
  }
  const groups = CV_GROUPS;
  const ordered = cvDisplaySections(content).map(item => item.section);
  const measureSection = (section: CvContent["sections"][number]) => {
      // Education and Skills share a parent section, with a subsection for each. Qualifications carry
      // their own label in the bullet; retain headings only when they add information.
      const canonical = (value: string) => clean(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      const label = canonical(section.heading);
      const firstBullet = canonical(section.bullets[0] ?? "");
      const headingInBullet = section.kind === "education" && (firstBullet === label || firstBullet.startsWith(label + " "));
      const showHeading = section.kind !== "skill" && !headingInBullet;
      const sectionHeading = section.kind === "skill" ? "Skills" : section.heading;
      doc.font("Helvetica-Bold").fontSize(10);
      const headerHeight = showHeading ? doc.heightOfString(clean(sectionHeading), { width, lineGap: 2.5 }) + 3 : 0;
      doc.font("Helvetica");
      const bulletHeights = (section.skillItems ?? section.bullets).map(bullet => doc.heightOfString(clean(bullet), { width: width - 12, lineGap: 2.5 }));
      const industryRows = measurePillRows(doc, section.industryDescriptions ?? [], width, PILL_STYLES.industry);
      const industryHeight = industryRows.length ? industryRows.reduce((sum, row) => sum + row.height, 0) + (industryRows.length - 1) * PILL_STYLES.industry.gapY + 6 : 0;
      const skillRows = section.kind === "skill" && theme.skillPills
        ? measurePillRows(doc, section.skillItems ?? section.bullets.flatMap(bullet => bullet.split(" · ").map(item => item.trim()).filter(Boolean)), width, PILL_STYLES.skill) : [];
      const firstHeight = skillRows[0]?.height ?? bulletHeights[0] ?? 0;
      const minimumHeight = headerHeight + industryHeight + firstHeight + 4;
      const contentHeight = skillRows.length
        ? skillRows.reduce((sum, row) => sum + row.height + PILL_STYLES.skill.gapY, 2)
        : bulletHeights.reduce((sum, height) => sum + height + 3.5, 0);
      return { section, sectionHeading, showHeading, industryRows, skillRows, minimumHeight, wholeHeight: headerHeight + industryHeight + contentHeight + 6 };
  };
  let educationSkillsStarted = false;
  for (const { kind, title } of groups) {
    const sections = ordered.filter(s => s.kind === kind).map(measureSection);
    if (!sections.length) continue;
    const first = sections[0]!;
    if (kind === "education" || kind === "skill") {
      if (!educationSkillsStarted) {
        heading("Education and Skills", 20 + first.minimumHeight);
        educationSkillsStarted = true;
      } else room(20 + first.minimumHeight);
      text(title, true, 10); doc.moveDown(0.5);
    } else heading(title, first.minimumHeight);
    for (const [index, layout] of sections.entries()) {
      const { section, sectionHeading, showHeading, industryRows, skillRows, minimumHeight, wholeHeight } = layout;
      // Preserve short roles intact when possible. Never strand a group heading.
      room(index > 0 && wholeHeight <= doc.page.height - 99 ? wholeHeight : minimumHeight);
      if (showHeading) { text(sectionHeading, true); doc.moveDown(0.25); }
      if (industryRows.length) {
        let top = doc.y;
        for (const row of industryRows) {
          drawPillRow(doc, row, 44, top, theme.pill, PILL_STYLES.industry);
          top += row.height + PILL_STYLES.industry.gapY;
        }
        doc.x = 44; doc.y = top - PILL_STYLES.industry.gapY + 6;
      }
      if (skillRows.length) {
        for (const row of skillRows) {
          if (doc.y + row.height > doc.page.height - 55) {
            doc.addPage(); text("Skills (continued)", true); doc.moveDown(0.3);
          }
          const top = doc.y;
          drawPillRow(doc, row, 44, top, theme.pill, PILL_STYLES.skill);
          doc.x = 44; doc.y = top + row.height + PILL_STYLES.skill.gapY;
        }
        doc.y += 2;
      } else for (const bullet of section.skillItems ?? section.bullets) {
        doc.font("Helvetica").fontSize(10);
        const height = doc.heightOfString(clean(bullet), { width: width - 12, lineGap: 2.5 });
        if (doc.y + height + 5 > doc.page.height - 55) {
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
    doc.font("Helvetica").fontSize(8).fillColor(ink).text(`${i + 1} / ${range.count}`, 44, doc.page.height - 30, { width, align: "right", lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return { pdf: await result, pageCount: range.count };
}
