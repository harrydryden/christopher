import { cvSectionHeading, cvSectionTexts } from "./cv-format";
import PDFDocument from "pdfkit";
import { DEFAULT_CV_THEME, cvForeground, cvDisplaySections, cvMaxPages, CvContentSchema, CV_GROUPS, type CvContent, type CvFont } from "./cv";
import { LIBERATION_SANS_BOLD, LIBERATION_SANS_REGULAR } from "./fonts/liberation-sans";

import { cleanCvText, measurePillRows, drawPillRow, PILL_STYLES } from "./cv-pdf-pills";

export class CvLayoutError extends Error {}
export function assertCvPageLimit(pageCount: number, maxPages: number): void {
  if (pageCount > maxPages) throw new CvLayoutError(`CV is ${pageCount} pages; the maximum is ${maxPages}. Save a new revision to fit and assess it automatically.`);
}

const decodeFont = (base64: string) => Buffer.from(base64.replace(/\s+/g, ""), "base64");
let liberationSans: { regular: Buffer; bold: Buffer } | undefined;
/** AVA is pdfkit's built-in Helvetica; Arial embeds the bundled Liberation Sans bytes. */
function registerCvFont(doc: PDFKit.PDFDocument, font: CvFont): { regular: string; bold: string } {
  if (font !== "Arial") return { regular: "Helvetica", bold: "Helvetica-Bold" };
  liberationSans ??= { regular: decodeFont(LIBERATION_SANS_REGULAR), bold: decodeFont(LIBERATION_SANS_BOLD) };
  doc.registerFont("Arial", liberationSans.regular);
  doc.registerFont("Arial-Bold", liberationSans.bold);
  return { regular: "Arial", bold: "Arial-Bold" };
}

/** Server-side, selectable-text A4 PDF held to the content's own page limit. No browser, remote fonts or model-authored HTML. */
export async function renderCvPdf(content: CvContent): Promise<Buffer> {
  const result = await renderCvPdfWithReport(content);
  assertCvPageLimit(result.pageCount, result.maxPages);
  return result.pdf;
}

/** Renders every page so a preview can show an overrun; callers compare pageCount with maxPages. */
export async function renderCvPdfWithReport(
  content: CvContent,
): Promise<{ pdf: Buffer; pageCount: number; maxPages: number }> {
  content = CvContentSchema.parse(content);
  const doc = new PDFDocument({
    size: "A4",
    margin: 44,
    bufferPages: true,
    info: { Title: `${content.name} - CV`, Author: content.name },
  });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const theme = content.theme ?? DEFAULT_CV_THEME;
  const face = registerCvFont(doc, theme.font);
  const ink = cvForeground(theme.background);
  const accent = theme.primary;
  const paintPage = () => {
    doc
      .save()
      .rect(0, 0, doc.page.width, doc.page.height)
      .fill(theme.background);
    doc.restore();
  };
  paintPage();
  doc.on("pageAdded", paintPage);
  const width = doc.page.width - 88;
  const clean = cleanCvText;
  const text = (value: string, bold = false, size = 10) => {
    doc
      .font(bold ? face.bold : face.regular)
      .fontSize(size)
      .fillColor(ink)
      .text(clean(value), { width, lineGap: 2.5 });
  };
  const room = (height: number) => {
    if (doc.y + height > doc.page.height - 55) doc.addPage();
  };
  const heading = (value: string, followingHeight: number) => {
    doc.font(face.bold).fontSize(11);
    room(
      doc.heightOfString(value.toUpperCase(), { width, lineGap: 0 }) +
        29 +
        followingHeight,
    );
    {
      const top = doc.y + 10;
      const label = value.toUpperCase();
      doc.font(face.bold).fontSize(11);
      doc.fillColor(ink).text(label, 44, top, { width, lineGap: 0 });
      const underlineTop = doc.y + 3;
      doc.rect(44, underlineTop, width, 3).fill(accent);
      doc.x = 44;
      doc.y = underlineTop + 16;
    }
  };
  const contact = clean(content.contact).replace(/\s+/g, " ").trim();
  const drawContact = (colour: string) => {
    doc.font(face.regular).fontSize(9).fillColor(colour);
    const links = [
      ...(content.linkedinUrl ? [{ label: "LinkedIn", url: content.linkedinUrl }] : []),
      ...(content.websiteUrl ? [{ label: "Website", url: content.websiteUrl }] : []),
    ];
    if (contact) doc.text(contact + (links.length ? " · " : ""), { width, lineGap: 2.5, continued: links.length > 0 });
    links.forEach((link, index) => {
      doc.text(link.label, { link: link.url, underline: true, width, lineGap: 2.5, continued: index < links.length - 1 });
      if (index < links.length - 1) doc.text(" · ", { link: null, underline: false, continued: true });
    });
  };
  {
    // Measure before painting so the coloured masthead grows with the actual content.
    doc.font(face.bold).fontSize(22);
    const nameHeight = doc.heightOfString(clean(content.name), {
      width,
      lineGap: 2.5,
    });
    doc.font(face.regular).fontSize(9);
    const contactText = [contact, content.linkedinUrl ? "LinkedIn" : "", content.websiteUrl ? "Website" : ""]
      .filter(Boolean)
      .join(" · ");
    const contactHeight = contactText
      ? doc.heightOfString(contactText, { width, lineGap: 2.5 })
      : 0;
    const contactTop = 34 + nameHeight + 14;
    const profileTop = contactTop + contactHeight + 20;
    const profileWidth = theme.introPanel ? width - 110 : width;
    doc.font(face.regular).fontSize(10);
    const summaryHeight = doc.heightOfString(clean(content.summary), {
      width: profileWidth,
      lineGap: 2.5,
    });
    const profileHeight = Math.max(20, summaryHeight) + 28;
    const headerBottom = profileTop + profileHeight + 22;
    if (headerBottom > doc.page.height - 55)
      throw new CvLayoutError(
        "The name, contact details and profile exceed one page. Shorten the profile before rendering.",
      );
    doc.rect(0, 0, doc.page.width, headerBottom).fill(accent);
    const headerInk = cvForeground(accent);
    doc
      .font(face.bold)
      .fontSize(22)
      .fillColor(headerInk)
      .text(clean(content.name), 44, 34, { width, lineGap: 2.5 });
    doc.x = 44;
    doc.y = contactTop;
    drawContact(headerInk);
    if (theme.introPanel) {
      doc
        .roundedRect(44, profileTop, width, profileHeight, 12)
        .fill(theme.surface);
      const panelInk = cvForeground(theme.surface);
      doc
        .font(face.bold)
        .fontSize(10)
        .fillColor(panelInk)
        .text("Profile", 60, profileTop + 14, { width: 62 });
      doc
        .moveTo(130, profileTop + 12)
        .lineTo(130, profileTop + profileHeight - 12)
        .lineWidth(0.5)
        .strokeColor(panelInk)
        .stroke();
      doc
        .font(face.regular)
        .fontSize(10)
        .fillColor(panelInk)
        .text(clean(content.summary), 144, profileTop + 14, {
          width: profileWidth,
          lineGap: 2.5,
        });
    } else {
      doc
        .font(face.regular)
        .fontSize(10)
        .fillColor(headerInk)
        .text(clean(content.summary), 44, profileTop + 14, {
          width,
          lineGap: 2.5,
        });
    }
    doc.x = 44;
    doc.y = headerBottom + 8;
  }
  const groups = CV_GROUPS;
  const ordered = cvDisplaySections(content).map((item) => item.section);
  const skillSectionGap = 9;
  const pageBodyHeight = doc.page.height - 55 - 44;
  const quietBottomSpace = 100;
  const skillHeadingColour = accent;
  const measureSection = (section: CvContent["sections"][number]) => {
    // Education and Skills share a parent section, with a subsection for each. Qualifications carry
    // their own label in the bullet; retain headings only when they add information.
    const sectionHeading = section.kind === "skill" ? clean(section.heading) : cvSectionHeading(section);
    const showHeading = sectionHeading !== null;
    doc.font(face.bold).fontSize(section.kind === "skill" ? 9 : 10);
    const headerHeight = showHeading
      ? doc.heightOfString(sectionHeading, { width, lineGap: 2.5 }) + 4
      : 0;
    doc.font(face.regular).fontSize(10);
    const bulletHeights = (section.skillItems ?? section.bullets).map(
      (bullet) =>
        doc.heightOfString(clean(bullet), { width: width - 12, lineGap: 2.5 }),
    );
    const industryRows = measurePillRows(
      doc,
      section.industryDescriptions ?? [],
      width,
      PILL_STYLES.industry,
      face.regular,
    );
    const industryHeight = industryRows.length
      ? industryRows.reduce((sum, row) => sum + row.height, 0) +
        (industryRows.length - 1) * PILL_STYLES.industry.gapY +
        6
      : 0;
    const skillRows =
      section.kind === "skill"
        ? measurePillRows(
            doc,
            cvSectionTexts(section),
            width,
            PILL_STYLES.skill,
            face.regular,
            { label: sectionHeading!, font: face.bold },
          )
        : [];
    const firstSkillRowIndex = skillRows.findIndex(row => row.pills.some(pill => !pill.heading));
    const firstSkillHeight = firstSkillRowIndex < 0 ? 0 : skillRows.slice(0, firstSkillRowIndex + 1)
      .reduce((sum, row) => sum + row.height, 0) + firstSkillRowIndex * PILL_STYLES.skill.gapY;
    const firstHeight = skillRows[0]?.height ?? bulletHeights[0] ?? 0;
    const experienceStartHeight = (count: number) => headerHeight + industryHeight +
      bulletHeights.slice(0, count).reduce((sum, height) => sum + height + 3.5, 0) + 6;
    const minimumHeight = section.kind === "skill"
      ? firstSkillHeight + skillSectionGap
      : section.kind === "experience"
        ? experienceStartHeight(1)
        : headerHeight + industryHeight + firstHeight + 4;
    const contentHeight = skillRows.length
      ? skillRows.reduce(
          (sum, row) => sum + row.height + PILL_STYLES.skill.gapY,
          2,
        )
      : bulletHeights.reduce((sum, height) => sum + height + 3.5, 0);
    const skillContentHeight = skillRows.reduce((sum, row) => sum + row.height, 0) +
      Math.max(0, skillRows.length - 1) * PILL_STYLES.skill.gapY;
    return {
      section,
      sectionHeading,
      showHeading,
      industryRows,
      skillRows,
      minimumHeight,
      experienceStartHeight: section.kind === "experience" ? experienceStartHeight(Math.min(2, bulletHeights.length)) : 0,
      wholeHeight: section.kind === "skill"
        ? skillContentHeight + skillSectionGap
        : headerHeight + industryHeight + contentHeight + 6,
    };
  };
  let educationSkillsStarted = false;
  for (const { kind, title } of groups) {
    const sections = ordered.filter((s) => s.kind === kind).map(measureSection);
    if (!sections.length) continue;
    const first = sections[0]!;
    const keepFirstSkillRow = kind === "skill" &&
      first.wholeHeight <= pageBodyHeight - (educationSkillsStarted ? 20 : 60);
    if (kind === "education" || kind === "skill") {
      const followingHeight = keepFirstSkillRow ? first.wholeHeight : first.minimumHeight;
      if (!educationSkillsStarted) {
        heading("Education and Skills", 20 + followingHeight);
        educationSkillsStarted = true;
      } else room(20 + followingHeight);
      text(title, true, 10);
      doc.moveDown(0.5);
    } else heading(title, kind === "experience" ? first.experienceStartHeight : first.minimumHeight);
    for (const [index, layout] of sections.entries()) {
      const {
        section,
        sectionHeading,
        showHeading,
        industryRows,
        skillRows,
        minimumHeight,
        wholeHeight,
        experienceStartHeight,
      } = layout;
      if (section.kind === "experience") {
        const remaining = doc.page.height - 55 - doc.y;
        // Use the bottom of a page if a role can begin with its heading and complete bullets.
        // Move a short role whole only when doing so leaves little unused space behind.
        if (wholeHeight <= remaining) {
          room(wholeHeight);
        } else if (wholeHeight <= pageBodyHeight && remaining <= quietBottomSpace) {
          room(wholeHeight);
        } else if (experienceStartHeight <= remaining) {
          room(experienceStartHeight);
        } else if (minimumHeight <= remaining && remaining > quietBottomSpace) {
          room(minimumHeight);
        } else {
          room(Math.max(experienceStartHeight, remaining + 1));
        }
      } else {
        // Preserve short education and skill sections intact when possible.
        const keepWhole = section.kind === "skill"
          ? (index === 0 ? keepFirstSkillRow : wholeHeight <= pageBodyHeight)
          : index > 0 && wholeHeight <= pageBodyHeight;
        room(keepWhole ? wholeHeight : minimumHeight);
      }
      if (section.kind === "skill") {
        let top = doc.y;
        let rows = skillRows;
        let rowIndex = 0;
        while (rowIndex < rows.length) {
          const row = rows[rowIndex]!;
          if (top + row.height > doc.page.height - 55) {
            doc.addPage();
            const remaining = rows.slice(rowIndex).flatMap(item => item.pills.filter(pill => !pill.heading).map(pill => pill.label));
            rows = measurePillRows(doc, remaining, width, PILL_STYLES.skill, face.regular,
              { label: `${sectionHeading} (continued)`, font: face.bold });
            rowIndex = 0;
            top = doc.y;
            continue;
          }
          drawPillRow(doc, row, 44, top, theme.pill, PILL_STYLES.skill, face.regular,
            { colour: skillHeadingColour, font: face.bold });
          top += row.height + PILL_STYLES.skill.gapY;
          rowIndex++;
        }
        doc.x = 44;
        doc.y = top - (rows.length ? PILL_STYLES.skill.gapY : 0) + skillSectionGap;
        continue;
      }
      if (showHeading && sectionHeading) {
        text(sectionHeading, true, 10);
        doc.moveDown(0.25);
      }
      if (industryRows.length) {
        let top = doc.y;
        for (const row of industryRows) {
          drawPillRow(doc, row, 44, top, theme.pill, PILL_STYLES.industry, face.regular);
          top += row.height + PILL_STYLES.industry.gapY;
        }
        doc.x = 44;
        doc.y = top - PILL_STYLES.industry.gapY + 6;
      }
      for (const bullet of section.skillItems ?? section.bullets) {
          doc.font(face.regular).fontSize(10);
          const height = doc.heightOfString(clean(bullet), {
            width: width - 12,
            lineGap: 2.5,
          });
          if (doc.y + height + 5 > doc.page.height - 55) {
            doc.addPage();
            text(`${sectionHeading ?? "Skills"} (continued)`, true);
            doc.moveDown(0.3);
          } else room(height + 5);
          doc.font(face.regular).fontSize(10).fillColor(ink);
          const y = doc.y;
          doc.text("•", 44, y, { width: 10 });
          doc.text(clean(bullet), 56, y, { width: width - 12, lineGap: 2.5 });
          doc.x = 44;
          doc.moveDown(0.3);
      }
      doc.moveDown(0.45);
    }
  }
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Reserve footer space without triggering another automatic page.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .font(face.regular)
      .fontSize(8)
      .fillColor(ink)
      .text(`${i + 1} / ${range.count}`, 44, doc.page.height - 30, {
        width,
        align: "right",
        lineBreak: false,
      });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return { pdf: await result, pageCount: range.count, maxPages: cvMaxPages(theme) };
}
