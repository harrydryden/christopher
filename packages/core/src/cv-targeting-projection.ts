import type { CvContent } from "./cv";
import type { CvEntryTreatment, CvTargetingBriefV1 } from "./cv-targeting";

/** Browser-safe projection; the server parses the result against CvContentSchema. */
export function cvEntryTreatment(brief: Pick<CvTargetingBriefV1, "entries"> | null | undefined, entryId: string): CvEntryTreatment {
  return brief?.entries.find(row => row.entryId === entryId)?.treatment ?? "feature";
}

/** A summary without citations cannot be proved independent of omitted evidence. */
export function cvTargetingSummaryNeedsReview(content: CvContent, brief: Pick<CvTargetingBriefV1, "entries">): boolean {
  const omitted = new Set(brief.entries.filter(row => row.treatment === "omit").map(row => row.entryId));
  if (!omitted.size) return false;
  if (!content.summarySources?.length) return true;
  return content.summarySources.some(id => {
    if (id === "source:profile") return true;
    const match = /^entry:(.+?)(?::(?:row|skill):\d+)?$/.exec(id);
    return !!match && omitted.has(match[1]!);
  });
}

/** Preserve full manual wording through Feature → Summarise/Omit → Feature. */
export function projectCvTargetedSections(content: CvContent, brief: Pick<CvTargetingBriefV1, "entries">,
  previousBrief?: Pick<CvTargetingBriefV1, "entries" | "manualSections"> | null): {
  sections: CvContent["sections"]; manualSections: CvContent["sections"]; summaryNeedsReview: boolean;
} {
  const originals = new Map((previousBrief?.manualSections ?? content.sections).map(section => [section.entryId, section]));
  const current = new Map(content.sections.map(section => [section.entryId, section]));
  // An absent previously visible section was removed in the editor. An absent previously omitted
  // section is held deliberately for a later Feature restoration.
  for (const id of originals.keys())
    if (!current.has(id) && cvEntryTreatment(previousBrief, id) !== "omit") originals.delete(id);
  for (const section of content.sections) {
    const previous = originals.get(section.entryId);
    const oldTreatment = cvEntryTreatment(previousBrief, section.entryId);
    if (!previous || oldTreatment === "feature") originals.set(section.entryId, section);
    else if (oldTreatment === "summarise") originals.set(section.entryId, {
      ...previous, heading: section.heading, industryDescriptions: section.industryDescriptions,
      bullets: [section.bullets[0]!, ...previous.bullets.slice(1)],
      ...(previous.bulletSources || section.bulletSources ? { bulletSources: [section.bulletSources?.[0] ?? previous.bulletSources?.[0] ?? [], ...(previous.bulletSources?.slice(1) ?? [])] } : {}),
      ...(previous.bulletSignposts || section.bulletSignposts ? { bulletSignposts: [section.bulletSignposts?.[0] ?? previous.bulletSignposts?.[0] ?? null, ...(previous.bulletSignposts?.slice(1) ?? [])] } : {}),
    });
  }
  const manualSections = [...originals.values()];
  const sections = manualSections.flatMap(saved => {
    const section = current.get(saved.entryId) ?? saved;
    const treatment = cvEntryTreatment(brief, section.entryId);
    if (treatment === "omit") return [];
    if (treatment === "feature") return [saved];
    return [{ ...section, bullets: section.bullets.slice(0, 1),
      ...(section.bulletSources ? { bulletSources: section.bulletSources.slice(0, 1) } : {}),
      ...(section.bulletSignposts ? { bulletSignposts: section.bulletSignposts.slice(0, 1) } : {}) }];
  });
  if (!sections.length) throw new Error("Keep at least one CV section when choosing what to omit.");
  return { sections, manualSections, summaryNeedsReview: cvTargetingSummaryNeedsReview(content, brief) };
}
