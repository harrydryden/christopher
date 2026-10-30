import type { CvContent, CvLibrary } from "@col/core/cv";
import type { CvTargetingBriefV1 } from "@col/core/cv-targeting";
import type { CvPdfLayoutReport } from "@col/core/cv-pdf";
import type { CvAssessment } from "@col/core/cv-assessment";
import type { LibraryProposal } from "@col/core/library-import";
import { cvClaimItems } from "@col/core/cv-assessment";
import { cvQuoteIsAnchored } from "@col/core/cv-review";
import { cvSectionHeading, cvSectionTexts, cvSupportingTitle } from "@col/core/cv-format";

const identity = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-GB");

export type CvLinkedInComparison = { field: string; saved: string; uploaded: string;
  quote: string; status: "corroborating" | "needs_review" };

/** A resolved import may have been dismissed; only its own confirmed rows prove review. */
export function linkedInImportHasConfirmedEvidence(library: CvLibrary, importId: string, resolvedAt: Date | null): boolean {
  if (!resolvedAt) return false;
  const prefix = `${importId}:`;
  return library.entries.some(entry => entry.id.startsWith(prefix) && entry.status !== "inactive"
    && (entry.kind === "education" || entry.kind === "training" ||
      (entry.kind === "experience" && (entry.confirmedResponsibilities?.length ?? 0) > 0)));
}

export function cvEmphasisScan(brief: CvTargetingBriefV1 | null, assessment: CvAssessment | null,
  layout: CvPdfLayoutReport | null, content?: CvContent | null) {
  if (!brief || !assessment || !layout) return [];
  const pages = new Map(layout.claimPages.map(item => [item.claimId, item.startPage]));
  const claims = new Map(assessment.review.claims.map(item => [item.claimId, item.status]));
  const claimText = new Map(content ? cvClaimItems(content).map(item => [item.id, item.text]) : []);
  return brief.priority.emphasisRequirementIds.map(id => {
    const requirement = assessment.rubric.requirements.find(item => item.id === id);
    const match = assessment.review.matches.find(item => item.requirementId === id);
    const supportedPages = match?.cvEvidence.filter(ref => claims.get(ref.id) === "supported")
      .map(ref => pages.get(ref.id)).filter((page): page is number => page !== undefined) ?? [];
    const label = requirement?.label ?? id;
    return { id, label,
      terminologyOnFirstPage: supportedPages.includes(1) && label.length > 2 && match?.cvEvidence.some(ref =>
        claims.get(ref.id) === "supported" && pages.get(ref.id) === 1 && identity(claimText.get(ref.id) ?? "").includes(identity(label))) === true,
      status: match?.status === "demonstrated" && supportedPages.includes(1) ? "first_page" as const
        : match?.status === "demonstrated" && supportedPages.length ? "elsewhere" as const
          : "unconfirmed" as const };
  });
}

function explicitDate(value: string, quote: string): boolean {
  if (value === "Present") return /\b(?:present|current)\b/i.test(quote);
  if (!/^\d{4}(?:-\d{2})?$/.test(value)) return false;
  const year = value.slice(0, 4);
  if (value.length === 4) return new RegExp(`(?<!\\d)${year}(?!\\d)`).test(quote);
  const month = value.slice(5);
  return new RegExp(`(?<!\\d)${year}[-/. ]${month}(?!\\d)`).test(quote);
}

/** Only compare explicit, quote-anchored fields for a unique employer in each source. */
export function compareCvWithLinkedIn(library: CvLibrary, proposal: LibraryProposal, extractedText: string, importId: string): CvLinkedInComparison[] {
  const savedJobs = library.employment ?? [];
  const results: CvLinkedInComparison[] = [];
  for (const job of proposal.employment) {
    if (!job.quote || !cvQuoteIsAnchored(job.quote, extractedText)
      || !cvQuoteIsAnchored(job.company, job.quote) || !cvQuoteIsAnchored(job.title, job.quote)) continue;
    const importedJobId = `${importId}:${job.id}`;
    if (!library.entries.some(entry => entry.id === `${importedJobId}:evidence` && entry.kind === "experience"
      && entry.employmentId === importedJobId && entry.status !== "inactive"
      && (entry.confirmedResponsibilities?.length ?? 0) > 0)) continue;
    const matched = savedJobs.filter(item => identity(item.company) === identity(job.company));
    if (matched.length !== 1 || matched[0]?.id !== importedJobId
      || proposal.employment.filter(item => identity(item.company) === identity(job.company)).length !== 1) continue;
    const saved = matched[0]!;
    const fields = [
      ["Job title", saved.jobTitle, job.title],
      ["Start date", saved.startDate, job.startDate],
      ["End date", saved.current ? "Present" : saved.endDate, job.current ? "Present" : job.endDate],
    ] as const;
    for (const [field, savedValue, uploadedValue] of fields) {
      if (!savedValue || !uploadedValue) continue;
      if (field !== "Job title" && (savedValue.length !== uploadedValue.length || !explicitDate(uploadedValue, job.quote))) continue;
      results.push({ field: `${job.company} · ${field}`, saved: savedValue, uploaded: uploadedValue,
        quote: job.quote, status: identity(savedValue) === identity(uploadedValue) ? "corroborating" : "needs_review" });
    }
  }
  for (const qualification of proposal.education) {
    if (!qualification.quote || !cvQuoteIsAnchored(qualification.quote, extractedText)
      || !cvQuoteIsAnchored(qualification.heading, qualification.quote)) continue;
    if (!library.entries.some(entry => entry.id === `${importId}:${qualification.id}` && entry.status !== "inactive"
      && entry.kind === (qualification.kind ?? "education") && identity(entry.heading) === identity(qualification.heading)
      && identity(entry.details) === identity(qualification.detail))) continue;
    const matched = library.entries.filter(item => item.kind === (qualification.kind ?? "education")
      && identity(item.heading) === identity(qualification.heading));
    if (matched.length !== 1 || proposal.education.filter(item => identity(item.heading) === identity(qualification.heading)).length !== 1) continue;
    const saved = matched[0]!;
    // Different prose may paraphrase the same qualification. Show an exact match, otherwise unknown.
    if (!saved.details || !qualification.detail || identity(saved.details) !== identity(qualification.detail)
      || !cvQuoteIsAnchored(qualification.detail, qualification.quote)) continue;
    results.push({ field: `${qualification.heading} · details`, saved: saved.details,
      uploaded: qualification.detail, quote: qualification.quote, status: "corroborating" });
  }
  return results.slice(0, 20);
}

export type CvInterviewCard = { entryId: string; heading: string; employer: string | null;
  dates: string | null; evidence: string; relevance: "role_mapped" | "additional" };

/** Omitted, confirmed rows remain available for a conversation without entering the CV. */
export function cvInterviewCards(library: CvLibrary, brief: CvTargetingBriefV1 | null,
  mappedSourceIds: readonly string[] = []): CvInterviewCard[] {
  if (!brief) return [];
  const omitted = new Set(brief.entries.filter(item => item.treatment === "omit").map(item => item.entryId));
  const mapped = new Set(mappedSourceIds.filter(id => /:row:\d+$/.test(id)));
  return library.entries.flatMap(entry => {
    if (!omitted.has(entry.id) || entry.kind !== "experience" || entry.status === "inactive") return [];
    const employment = library.employment?.find(item => item.id === entry.employmentId);
    return (entry.confirmedResponsibilities ?? []).map((evidence, index) => ({ entryId: entry.id,
      heading: employment?.jobTitle ?? entry.heading, employer: employment?.company ?? entry.company ?? null,
      dates: employment ? [employment.startDate, employment.current ? "Present" : employment.endDate].filter(Boolean).join(" – ") : null,
      evidence, relevance: mapped.has(`entry:${entry.id}:row:${index}`)
        ? "role_mapped" as const : "additional" as const }));
  }).sort((a, b) => Number(b.relevance === "role_mapped") - Number(a.relevance === "role_mapped")).slice(0, 8);
}

export function cvQuickScan(content: CvContent, layout: CvPdfLayoutReport) {
  const onFirstPage = new Set(layout.claimPages.filter(item => item.startPage === 1).map(item => item.claimId));
  const claims = cvClaimItems(content).filter(item => onFirstPage.has(item.id));
  const supporting = cvSupportingTitle(content.sections.map(section => section.kind));
  const printedWords = [content.name, content.contact, content.linkedinUrl ? "LinkedIn" : "",
    content.websiteUrl ? "Website" : "", "Executive Summary", content.summary,
    content.sections.some(section => section.kind === "experience") ? "Work experience" : "", supporting,
    ...content.sections.flatMap(section => [section.kind === "skill" ? section.heading : cvSectionHeading(section),
      ...(section.industryDescriptions ?? []), ...cvSectionTexts(section)])]
    .filter((value): value is string => !!value);
  return { summary: content.summary, summaryLines: layout.summaryLines,
    firstPageClaims: claims, firstPageEntryIds: layout.firstPageEntryIds,
    wordCount: printedWords.join(" ").trim().split(/\s+/).filter(Boolean).length };
}
