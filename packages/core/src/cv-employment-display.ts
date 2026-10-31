import type { CvContent, CvLibrary } from "./cv";
import { employmentCvHeading, employmentHeading, industryDescriptions, normalise } from "./cv-helpers";

export type CvEmploymentDisplay = ReadonlyMap<string, { heading: string; industry: string | null }>;

/**
 * Derive print-only company context from this CV's saved Experience snapshot. An edited heading is
 * never reinterpreted as a job title or date, and all roles at one company share one sourced pill.
 */
export function cvEmploymentDisplay(content: CvContent, library: CvLibrary): CvEmploymentDisplay {
  const jobs = new Map((library.employment ?? []).map(job => [job.id, job]));
  const entries = new Map(library.entries.map(entry => [entry.id, entry]));
  const sectionsByCompany = new Map<string, CvContent["sections"]>();
  for (const section of content.sections) {
    if (section.kind !== "experience") continue;
    const job = jobs.get(entries.get(section.entryId)?.employmentId ?? "");
    if (!job) continue;
    const key = normalise(job.company);
    sectionsByCompany.set(key, [...(sectionsByCompany.get(key) ?? []), section]);
  }
  const industryByCompany = new Map<string, string | null>();
  for (const [company, sections] of sectionsByCompany) {
    // An omitted role may carry a sector that the printed roles do not establish. Source only
    // from jobs actually represented by the sections on this CV.
    const available = sections.flatMap(section => industryDescriptions(
      jobs.get(entries.get(section.entryId)?.employmentId ?? "")?.industryDescriptions));
    const selected = sections.flatMap(section => section.industryDescriptions ?? [])
      .map(label => available.find(source => normalise(source) === normalise(label)))
      .find((label): label is string => !!label);
    industryByCompany.set(company, selected ?? available[0] ?? null);
  }
  const display = new Map<string, { heading: string; industry: string | null }>();
  for (const section of content.sections) {
    if (section.kind !== "experience") continue;
    const job = jobs.get(entries.get(section.entryId)?.employmentId ?? "");
    if (!job) continue;
    display.set(section.entryId, {
      heading: section.heading === employmentHeading(job) ? employmentCvHeading(job) : section.heading,
      industry: industryByCompany.get(normalise(job.company)) ?? null,
    });
  }
  return display;
}
