import { cvDisplayGroups, cvSectionHeading, cvSectionTexts, cvSupportingTitle } from "./cv-format";
import PDFDocument from "pdfkit";
import { DEFAULT_CV_THEME, cvForeground, cvMaxPages, CvContentSchema, type CvContent, type CvFont, type CvTheme } from "./cv";
import { LIBERATION_SANS_BOLD, LIBERATION_SANS_REGULAR } from "./fonts/liberation-sans";

import { cleanCvText, measurePillRows, drawPillRow, PILL_STYLES } from "./cv-pdf-pills";

export class CvLayoutError extends Error {}
export function assertCvPageLimit(pageCount: number, maxPages: number): void {
  if (pageCount > maxPages) throw new CvLayoutError(`CV is ${pageCount} pages; the maximum is ${maxPages}. Summarise or omit selected material, or change the page limit, then save and explicitly check the new revision.`);
}

export type CvPdfLayoutReport = {
  /** Measured with the selected font, width and line gap during this PDF render. */
  summaryLines: number;
  /** Source entry IDs that have printed content on page one, in print order. */
  firstPageEntryIds: string[];
  sectionPages: { entryId: string; startPage: number; endPage: number }[];
  /** Exact claim IDs used by the factual audit; a claim can occupy more than one page. */
  claimPages: { claimId: string; startPage: number; endPage: number }[];
};
export type CvEmploymentDisplay = ReadonlyMap<string, { heading: string; industry: string | null }>;

type PdfFontMetrics = { capHeight: number; ascender: number; descender: number };
type RoleIndustryPill = { label: string; width: number; height: number; topOffset: number; textTopOffset: number; fontSize: number };
const pdfFontMetrics = (doc: PDFKit.PDFDocument) =>
  (doc as PDFKit.PDFDocument & { _font: PdfFontMetrics })._font;

/** The experience pill is one cap-height line, separate from the padded skill pills. */
function measureRoleIndustryPill(doc: PDFKit.PDFDocument, source: string, maxWidth: number,
  face: { regular: string; bold: string }, headingSize: number): RoleIndustryPill {
  doc.font(face.bold).fontSize(headingSize);
  const headingFont = pdfFontMetrics(doc);
  const height = headingFont.capHeight * headingSize / 1000;
  const topOffset = (headingFont.ascender - headingFont.capHeight) * headingSize / 1000;
  doc.font(face.regular);
  const labelFont = pdfFontMetrics(doc);
  // Descenders must fit too; this only reduces the legacy label by a fraction of a point.
  const fontSize = Math.min(PILL_STYLES.industry.fontSize,
    (height - 0.4) * 1000 / (labelFont.capHeight - labelFont.descender));
  doc.fontSize(fontSize);
  const available = maxWidth - PILL_STYLES.industry.paddingX * 2 - 1;
  const original = cleanCvText(source);
  let label = original;
  if (doc.widthOfString(label) > available) {
    const chars = Array.from(original);
    let low = 0;
    let high = chars.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (doc.widthOfString(`${chars.slice(0, middle).join("").trimEnd()}…`) <= available) low = middle;
      else high = middle - 1;
    }
    label = `${chars.slice(0, low).join("").trimEnd()}…`;
  }
  const labelHeight = (labelFont.capHeight - labelFont.descender) * fontSize / 1000;
  const textTopOffset = (height - labelHeight) / 2 -
    (labelFont.ascender - labelFont.capHeight) * fontSize / 1000;
  return { label, width: Math.min(maxWidth, Math.ceil(doc.widthOfString(label) +
    PILL_STYLES.industry.paddingX * 2 + 1)), height, topOffset, textTopOffset, fontSize };
}

function drawRoleIndustryPill(doc: PDFKit.PDFDocument, pill: RoleIndustryPill, left: number, headingTop: number,
  colour: string, font: string): void {
  const top = headingTop + pill.topOffset;
  doc.roundedRect(left, top, pill.width, pill.height, pill.height / 2).fill(colour);
  doc.font(font).fontSize(pill.fontSize).fillColor(cvForeground(colour))
    .text(pill.label, left + PILL_STYLES.industry.paddingX, top + pill.textTopOffset,
      { width: pill.width - PILL_STYLES.industry.paddingX * 2, lineBreak: false, baseline: "top" });
}

const decodeFont = (base64: string) => Buffer.from(base64.replace(/\s+/g, ""), "base64");
let liberationSans: { regular: Buffer; bold: Buffer } | undefined;
/** Course of Life is pdfkit's built-in Helvetica; Arial embeds the bundled Liberation Sans bytes. */
function registerCvFont(doc: PDFKit.PDFDocument, font: CvFont): { regular: string; bold: string } {
  if (font !== "Arial") return { regular: "Helvetica", bold: "Helvetica-Bold" };
  liberationSans ??= { regular: decodeFont(LIBERATION_SANS_REGULAR), bold: decodeFont(LIBERATION_SANS_BOLD) };
  doc.registerFont("Arial", liberationSans.regular);
  doc.registerFont("Arial-Bold", liberationSans.bold);
  return { regular: "Arial", bold: "Arial-Bold" };
}

/** Actual renderer page and body-font geometry for an approximate writing envelope.
 * Callers subtract their selected headings, sections and first-page masthead; rendering
 * remains authoritative because line breaks depend on the final words. */
type CvBodyMetrics = {
  usablePageHeightPt: number;
  bodyWidthPt: number;
  lineHeightPt: number;
  representativeCharacterWidthPt: number;
  charactersPerLine: number;
};
// Six combinations: two supported fonts and legacy/default, 11pt or 12pt body text.
const bodyMetricsCache = new Map<string, CvBodyMetrics>();

export function cvPdfBodyMetrics(theme: CvTheme | undefined): CvBodyMetrics {
  theme ??= DEFAULT_CV_THEME;
  const key = `${theme.font}:${theme.bodySizePt ?? 10}`;
  const cached = bodyMetricsCache.get(key);
  if (cached) return { ...cached };
  const doc = new PDFDocument({ size: "A4", margin: 44 });
  const bodyWidthPt = doc.page.width - 88 - 12;
  const usablePageHeightPt = doc.page.height - 44 - 55;
  const sample = "Led a cross-functional team to deliver measurable results across the organisation.";
  doc.font(registerCvFont(doc, theme.font).regular).fontSize(theme.bodySizePt ?? 10);
  const lineHeightPt = doc.heightOfString("X", { width: bodyWidthPt, lineGap: 2.5 });
  const representativeCharacterWidthPt = doc.widthOfString(sample) / sample.length;
  doc.destroy();
  const metrics = { usablePageHeightPt, bodyWidthPt, lineHeightPt, representativeCharacterWidthPt,
    charactersPerLine: bodyWidthPt / representativeCharacterWidthPt };
  bodyMetricsCache.set(key, metrics);
  return { ...metrics };
}

/** Server-side, selectable-text A4 PDF held to the content's own page limit. No browser, remote fonts or model-authored HTML. */
export async function renderCvPdf(content: CvContent, employmentDisplay?: CvEmploymentDisplay): Promise<Buffer> {
  const result = await renderCvPdfWithReport(content, employmentDisplay);
  assertCvPageLimit(result.pageCount, result.maxPages);
  return result.pdf;
}

/** Renders every page so a preview can show an overrun; callers compare pageCount with maxPages. */
export async function renderCvPdfWithReport(
  content: CvContent,
  employmentDisplay?: CvEmploymentDisplay,
): Promise<{ pdf: Buffer; pageCount: number; maxPages: number; layout: CvPdfLayoutReport }> {
  return renderCvDocument(content, employmentDisplay, true);
}

/** Same layout engine as export, without compressing or retaining a disposable PDF. */
export async function measureCvPdf(content: CvContent, employmentDisplay?: CvEmploymentDisplay): Promise<{
  pageCount: number; maxPages: number; layout: CvPdfLayoutReport;
}> {
  const { pageCount, maxPages, layout } = await renderCvDocument(content, employmentDisplay, false);
  return { pageCount, maxPages, layout };
}

async function renderCvDocument(content: CvContent, employmentDisplay: CvEmploymentDisplay | undefined, collectPdf: boolean) {
  content = CvContentSchema.parse(content);
  const doc = new PDFDocument({
    size: "A4",
    margin: 44,
    bufferPages: true,
    compress: collectPdf,
    info: { Title: `${content.name} - CV`, Author: content.name },
  });
  const chunks: Buffer[] = [];
  const result = collectPdf ? new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  }) : null;
  if (!collectPdf) doc.resume();
  const theme = content.theme ?? DEFAULT_CV_THEME;
  const bodySize = theme.bodySizePt ?? 10;
  const targeted = theme.bodySizePt !== undefined;
  const layoutReport: CvPdfLayoutReport = { summaryLines: 0, firstPageEntryIds: [], sectionPages: [], claimPages: [] };
  const pageNumber = () => doc.bufferedPageRange().count;
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
  const text = (value: string, bold = false, size = bodySize) => {
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
    const headingSize = targeted ? 14 : 11;
    const headingTopGap = targeted ? 7 : 10;
    const headingBottomGap = targeted ? 10 : 16;
    doc.font(face.bold).fontSize(headingSize);
    room(
      doc.heightOfString(value.toUpperCase(), { width, lineGap: 0 }) +
        headingTopGap + headingBottomGap + 3 +
        followingHeight,
    );
    {
      const top = doc.y + headingTopGap;
      const label = value.toUpperCase();
      doc.font(face.bold).fontSize(headingSize);
      doc.fillColor(ink).text(label, 44, top, { width, lineGap: 0 });
      const underlineTop = doc.y + 3;
      doc.rect(44, underlineTop, width, 3).fill(accent);
      doc.x = 44;
      doc.y = underlineTop + headingBottomGap;
    }
  };
  const contact = clean(content.contact).replace(/\s+/g, " ").trim();
  const drawContact = (colour: string, left: number, top: number, availableWidth: number) => {
    doc.font(face.regular).fontSize(8.5).fillColor(colour);
    const links = [
      ...(content.linkedinUrl ? [{ label: "LinkedIn", url: content.linkedinUrl }] : []),
      ...(content.websiteUrl ? [{ label: "Website", url: content.websiteUrl }] : []),
    ];
    doc.x = left;
    doc.y = top;
    if (contact) doc.text(contact, { width: availableWidth, lineGap: 2.5, continued: links.length > 0,
      link: null, underline: false });
    links.forEach((link, index) => {
      if (contact || index) doc.text(" · ", { link: null, underline: false,
        width: availableWidth, lineGap: 2.5, continued: true });
      doc.text(link.label, { link: link.url, underline: true,
        width: availableWidth, lineGap: 2.5, continued: index < links.length - 1 });
    });
  };
  {
    // Measure before painting so the coloured masthead grows with the actual content.
    doc.font(face.bold).fontSize(22);
    const nameHeight = doc.heightOfString(clean(content.name), {
      width,
      lineGap: 2.5,
    });
    const nameWidth = doc.widthOfString(clean(content.name));
    doc.font(face.regular).fontSize(8.5);
    const contactText = [contact, content.linkedinUrl ? "LinkedIn" : "", content.websiteUrl ? "Website" : ""]
      .filter(Boolean)
      .join(" · ");
    const inlineContact = !!contactText && nameWidth + 16 + 150 <= width;
    const contactColumnWidth = inlineContact ? width - nameWidth - 16 : width;
    const contactHeight = contactText ? doc.heightOfString(contactText, { width: contactColumnWidth, lineGap: 2.5 }) : 0;
    const nameTop = targeted ? 18 : 34;
    const contactTop = inlineContact ? nameTop + Math.max(0, nameHeight - 17)
      : nameTop + nameHeight + (targeted ? 5 : 10);
    const profileTop = inlineContact ? Math.max(nameTop + nameHeight, contactTop + contactHeight) + (targeted ? 8 : 15)
      : contactTop + contactHeight + (targeted ? 8 : 15);
    const profileWidth = theme.introPanel ? width - 32 : width;
    doc.font(face.regular).fontSize(bodySize);
    const summaryHeight = doc.heightOfString(clean(content.summary), {
      width: profileWidth,
      lineGap: 2.5,
    });
    const singleSummaryLineHeight = doc.heightOfString("X", { width: profileWidth, lineGap: 2.5 });
    layoutReport.summaryLines = Math.max(1, Math.round(summaryHeight / singleSummaryLineHeight));
    const profileHeight = Math.max(20, summaryHeight) + (targeted ? 20 : 28);
    const headerBottom = profileTop + profileHeight + (targeted ? 8 : 16);
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
      .text(clean(content.name), 44, nameTop, { width, lineGap: 2.5 });
    if (contactText) drawContact(headerInk, inlineContact ? 44 + nameWidth + 16 : 44, contactTop,
      contactColumnWidth);
    if (theme.introPanel && targeted) {
      doc.roundedRect(44, profileTop, width, profileHeight, 12).fill(theme.surface);
      const panelInk = cvForeground(theme.surface);
      doc.font(face.regular).fontSize(bodySize).fillColor(panelInk)
        .text(clean(content.summary), 60, profileTop + 10, { width: width - 32, lineGap: 2.5 });
    } else if (theme.introPanel) {
      doc
        .roundedRect(44, profileTop, width, profileHeight, 12)
        .fill(theme.surface);
      const panelInk = cvForeground(theme.surface);
      doc
        .font(face.regular)
        .fontSize(10)
        .fillColor(panelInk)
        .text(clean(content.summary), 60, profileTop + 14, {
          width: profileWidth,
          lineGap: 2.5,
        });
    } else if (targeted) {
      doc.font(face.regular).fontSize(bodySize).fillColor(headerInk)
        .text(clean(content.summary), 44, profileTop + 10, { width, lineGap: 2.5 });
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
    doc.y = headerBottom + (targeted ? 5 : 8);
  }
  const groups = cvDisplayGroups(content);
  const ordered = groups.flatMap(group => group.sections.map(item => item.section));
  const skillSectionGap = 4;
  const skillPillStyle = targeted ? { ...PILL_STYLES.skill, fontSize: Math.max(11, bodySize - 1) } : PILL_STYLES.skill;
  const pageBodyHeight = doc.page.height - 55 - 44;
  const quietBottomSpace = 100;
  const skillHeadingColour = accent;
  const sectionHeadingSize = targeted ? 12 : 10;
  const bulletText = (section: CvContent["sections"][number], index: number) => {
    const signpost = section.bulletSignposts?.[index];
    return signpost ? `${clean(signpost)} · ${clean(section.bullets[index] ?? "")}` : clean(section.bullets[index] ?? "");
  };
  const measureSection = (section: CvContent["sections"][number]) => {
    // Qualifications keep their own heading, even if the first detail repeats its name.
    const display = section.kind === "experience" ? employmentDisplay?.get(section.entryId) : undefined;
    const sectionHeading = section.kind === "skill" ? clean(section.heading)
      : section.kind === "experience" ? clean(display?.heading ?? section.heading) : cvSectionHeading(section);
    const showHeading = sectionHeading !== null;
    const industryLabels = section.kind === "experience"
      ? [clean(display ? display.industry ?? "Industry unspecified"
        : section.industryDescriptions?.find(item => clean(item)) ?? "Industry unspecified")]
      : section.industryDescriptions ?? [];
    const rolePill = section.kind === "experience"
      ? measureRoleIndustryPill(doc, industryLabels[0]!, Math.min(160, width * 0.34), face, sectionHeadingSize)
      : null;
    const industryRows = section.kind === "experience" ? [] :
      measurePillRows(doc, industryLabels, width, PILL_STYLES.industry, face.regular);
    const rolePillWidth = rolePill?.width ?? 0;
    const roleHeadingWidth = width - rolePillWidth - PILL_STYLES.industry.gapX - 4;
    doc.font(face.bold).fontSize(section.kind === "skill" ? 9 : sectionHeadingSize);
    const headerHeight = showHeading
      ? section.kind === "experience"
        ? Math.max(rolePill!.topOffset + rolePill!.height,
          doc.heightOfString(sectionHeading, { width: roleHeadingWidth, lineGap: 2.5 })) + 6
        : doc.heightOfString(sectionHeading, { width, lineGap: 2.5 }) + 4
      : 0;
    const bulletHeights = (section.skillItems ?? section.bullets).map((bullet, index) => {
      const signpost = section.bulletSignposts?.[index];
      doc.font(signpost ? face.bold : face.regular).fontSize(bodySize);
      return doc.heightOfString(signpost ? bulletText(section, index) : clean(bullet), { width: width - 12, lineGap: 2.5 });
    });
    const industryHeight = section.kind !== "experience" && industryRows.length
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
            skillPillStyle,
            face.regular,
            { label: sectionHeading!, font: face.bold },
          )
        : [];
    const firstSkillRowIndex = skillRows.findIndex(row => row.pills.some(pill => !pill.heading));
    const firstSkillHeight = firstSkillRowIndex < 0 ? 0 : skillRows.slice(0, firstSkillRowIndex + 1)
      .reduce((sum, row) => sum + row.height, 0) + firstSkillRowIndex * skillPillStyle.gapY;
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
          (sum, row) => sum + row.height + skillPillStyle.gapY,
          2,
        )
      : bulletHeights.reduce((sum, height) => sum + height + 3.5, 0);
    const skillContentHeight = skillRows.reduce((sum, row) => sum + row.height, 0) +
      Math.max(0, skillRows.length - 1) * skillPillStyle.gapY;
    return {
      section,
      sectionHeading,
      showHeading,
      headerHeight,
      industryRows,
      rolePill,
      rolePillWidth,
      roleHeadingWidth,
      skillRows,
      minimumHeight,
      experienceStartHeight: section.kind === "experience" ? experienceStartHeight(Math.min(2, bulletHeights.length)) : 0,
      wholeHeight: section.kind === "skill"
        ? skillContentHeight + skillSectionGap
        : headerHeight + industryHeight + contentHeight + 6,
    };
  };
  const supplementary = groups.filter(group => group.kind !== "experience");
  const names = supplementary.map(group => group.title);
  const supplementaryTitle = cvSupportingTitle(ordered.map(section => section.kind));
  let supplementaryStarted = false;
  for (const { kind, title, sections: groupSections } of groups) {
    const sections = groupSections.map(item => measureSection(item.section));
    if (!sections.length) continue;
    const first = sections[0]!;
    const keepFirstSkillRow = kind === "skill" &&
      first.wholeHeight <= pageBodyHeight - (supplementaryStarted ? 20 : 60);
    if (kind !== "experience") {
      const followingHeight = keepFirstSkillRow ? first.wholeHeight : first.minimumHeight;
      if (!supplementaryStarted) {
        heading(supplementaryTitle!, (names.length > 1 ? 20 : 0) + followingHeight);
        supplementaryStarted = true;
      } else {
        doc.font(face.bold).fontSize(sectionHeadingSize);
        const groupLabelHeight = doc.heightOfString(title, { width, lineGap: 2.5 }) +
          doc.currentLineHeight() * 0.5;
        room(groupLabelHeight + followingHeight);
      }
      if (names.length > 1) {
        text(title, true, sectionHeadingSize);
        doc.moveDown(0.5);
      }
    } else heading(title, kind === "experience" ? first.experienceStartHeight : first.minimumHeight);
    for (const [index, layout] of sections.entries()) {
      const {
        section,
        sectionHeading,
        showHeading,
        headerHeight,
        industryRows,
        rolePill,
        rolePillWidth,
        roleHeadingWidth,
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
      const startPage = pageNumber();
      if (startPage === 1) layoutReport.firstPageEntryIds.push(section.entryId);
      if (section.kind === "skill") {
        let top = doc.y;
        let rows = skillRows;
        let rowIndex = 0;
        let printedSkillCount = 0;
        while (rowIndex < rows.length) {
          const row = rows[rowIndex]!;
          if (top + row.height > doc.page.height - 55) {
            doc.addPage();
            const remaining = rows.slice(rowIndex).flatMap(item => item.pills.filter(pill => !pill.heading).map(pill => pill.label));
            rows = measurePillRows(doc, remaining, width, skillPillStyle, face.regular,
              { label: `${sectionHeading} (continued)`, font: face.bold });
            rowIndex = 0;
            top = doc.y;
            continue;
          }
          drawPillRow(doc, row, 44, top, theme.pill, skillPillStyle, face.regular,
            { colour: skillHeadingColour, font: face.bold });
          for (const pill of row.pills) if (!pill.heading) {
            layoutReport.claimPages.push({ claimId: `section:${section.entryId}:${printedSkillCount++}`,
              startPage: pageNumber(), endPage: pageNumber() });
          }
          top += row.height + skillPillStyle.gapY;
          rowIndex++;
        }
        doc.x = 44;
        doc.y = top - (rows.length ? skillPillStyle.gapY : 0) + skillSectionGap;
        layoutReport.sectionPages.push({ entryId: section.entryId, startPage, endPage: pageNumber() });
        continue;
      }
      if (section.kind === "experience" && sectionHeading) {
        const top = doc.y;
        drawRoleIndustryPill(doc, rolePill!, 44, top, theme.pill, face.regular);
        doc.font(face.bold).fontSize(sectionHeadingSize).fillColor(ink)
          .text(sectionHeading, 44 + rolePillWidth + PILL_STYLES.industry.gapX + 4, top,
            { width: roleHeadingWidth, lineGap: 2.5 });
        doc.x = 44;
        doc.y = top + headerHeight;
      } else if (showHeading && sectionHeading) {
        text(sectionHeading, true, sectionHeadingSize);
        doc.moveDown(0.25);
      }
      if (section.kind !== "experience" && industryRows.length) {
        let top = doc.y;
        for (const row of industryRows) {
          drawPillRow(doc, row, 44, top, theme.pill, PILL_STYLES.industry, face.regular);
          top += row.height + PILL_STYLES.industry.gapY;
        }
        doc.x = 44;
        doc.y = top - PILL_STYLES.industry.gapY + 6;
      }
      for (const [bulletIndex, bullet] of (section.skillItems ?? section.bullets).entries()) {
          const signpost = section.bulletSignposts?.[bulletIndex];
          doc.font(signpost ? face.bold : face.regular).fontSize(bodySize);
          const height = doc.heightOfString(signpost ? bulletText(section, bulletIndex) : clean(bullet), {
            width: width - 12,
            lineGap: 2.5,
          });
          if (doc.y + height + 5 > doc.page.height - 55) {
            doc.addPage();
            if (section.kind !== "experience") {
              text(`${sectionHeading ?? "Skills"} (continued)`, true);
              doc.moveDown(0.3);
            }
          } else room(height + 5);
          doc.font(face.regular).fontSize(bodySize).fillColor(ink);
          const claimStartPage = pageNumber();
          const y = doc.y;
          doc.text("•", 44, y, { width: 10 });
          if (signpost) {
            doc.font(face.bold).text(`${clean(signpost)} · `, 56, y, { width: width - 12, lineGap: 2.5, continued: true });
            doc.font(face.regular).text(clean(bullet), { width: width - 12, lineGap: 2.5 });
          } else doc.text(clean(bullet), 56, y, { width: width - 12, lineGap: 2.5 });
          doc.x = 44;
          doc.moveDown(0.3);
          layoutReport.claimPages.push({ claimId: `section:${section.entryId}:${bulletIndex}`,
            startPage: claimStartPage, endPage: pageNumber() });
      }
      doc.moveDown(targeted ? 0.2 : 0.45);
      layoutReport.sectionPages.push({ entryId: section.entryId, startPage, endPage: pageNumber() });
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
  // Layout is complete before PDF serialisation. Measurements need neither font subsetting
  // nor a cross-reference table, so dispose of the stream without finalising a file.
  if (!collectPdf) {
    doc.destroy();
    return { pdf: Buffer.alloc(0), pageCount: range.count, maxPages: cvMaxPages(theme), layout: layoutReport };
  }
  doc.end();
  return { pdf: await result!, pageCount: range.count, maxPages: cvMaxPages(theme), layout: layoutReport };
}
