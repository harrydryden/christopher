/**
 * The one way a person's evidence is written out for the model.
 *
 * The planner, the writer and the auditor all read the same library, and each used to be sent its
 * own rendering of it: the writer received the stored library — every responsibility row once in
 * `details`, again in `confirmedResponsibilities` and a third time as a `rowFacets` key — and then a
 * fourth copy as the planner's addressable rows. This is the single serialisation: every row once,
 * with the source id a plan or a bullet cites it by and the facets the person tagged it with, under
 * the entry it belongs to, whose own id is the one the auditor cites a whole block by.
 *
 * Pure and deterministic: the same library always serialises to the same bytes, which is what lets
 * a block built from it be cached and read back by the next call of the same build.
 */
import { cvTailoringEvidence, rowFacets, type CvLibrary, type Employment, type EvidenceFacet } from "@ava/core";
import type { CvTextItem } from "@ava/core/cv-assessment";

export interface CanonicalEvidenceRow {
  /** `entry:<entryId>:row:<n>` or `entry:<entryId>:skill:<n>`: what a plan or a bullet cites. */
  id: string;
  text: string;
  /** What the person says the row carries (responsibility, problem, outcome, metric, milestone, style). */
  facets?: EvidenceFacet[];
}

export interface CanonicalEvidenceEntry {
  /** The entry's own id, as the library stores it: what the writer names a section by. */
  id: string;
  /** `entry:<id>`: what the audit cites a whole block by. */
  sourceId: string;
  kind: CvLibrary["entries"][number]["kind"];
  heading: string;
  /** The job an experience block belongs to, with its dates and the industries it describes. */
  employment?: Employment;
  /** A block written before employment history existed names its company itself. */
  company?: string;
  rows: CanonicalEvidenceRow[];
  /** A structured skill block's exact labels, each citable on its own. */
  skillItems?: CanonicalEvidenceRow[];
}

export interface CanonicalEvidence {
  profile?: { id: "source:profile"; text: string };
  entries: CanonicalEvidenceEntry[];
}

/**
 * The library as evidence: the profile and every active entry, each row once. Rows are exactly the
 * ones `cvTailoringEvidence` addresses — confirmed responsibilities for a job, every other row for
 * the rest, and not the labels that head a merged block — so an id in it is always one the plan and
 * provenance validators accept. Appearance and identity (theme, name, contact, links) and writing
 * preferences are not evidence and are never in it.
 */
export function canonicalEvidence(library: CvLibrary): CanonicalEvidence {
  const sources = cvTailoringEvidence(library);
  const byEntry = new Map<string, typeof sources>();
  for (const source of sources) if (source.entryId) byEntry.set(source.entryId, [...(byEntry.get(source.entryId) ?? []), source]);
  const entries = library.entries.filter(entry => entry.status !== "inactive").map((entry): CanonicalEvidenceEntry => {
    const own = byEntry.get(entry.id) ?? [];
    const row = (source: (typeof own)[number]): CanonicalEvidenceRow => {
      const facets = source.id.includes(":row:") ? rowFacets(entry, source.text) : [];
      return { id: source.id, text: source.text, ...(facets.length ? { facets } : {}) };
    };
    const employment = entry.employmentId ? library.employment?.find(job => job.id === entry.employmentId) : undefined;
    const skills = own.filter(source => source.id.includes(":skill:"));
    return {
      id: entry.id,
      sourceId: `entry:${entry.id}`,
      kind: entry.kind,
      heading: entry.heading,
      ...(employment ? { employment } : {}),
      ...(entry.company ? { company: entry.company } : {}),
      rows: own.filter(source => source.id.includes(":row:")).map(row),
      ...(entry.skillItems ? { skillItems: skills.map(row) } : {}),
    };
  });
  return {
    ...(library.profile.trim() ? { profile: { id: "source:profile" as const, text: library.profile } } : {}),
    entries,
  };
}

/** The canonical evidence as the exact bytes every prompt embeds. */
export function canonicalEvidenceBlock(library: CvLibrary): string {
  return JSON.stringify(canonicalEvidence(library));
}

/**
 * The canonical evidence as the audit's whole-block sources: the profile, then each entry's heading,
 * rows and skill labels as one text, which is the shape `cvEvidenceItems` gives the validators.
 */
export function canonicalEvidenceItems(evidence: CanonicalEvidence): CvTextItem[] {
  return [
    ...(evidence.profile ? [{ id: evidence.profile.id, text: evidence.profile.text }] : []),
    ...evidence.entries.map(entry => ({
      id: entry.sourceId,
      text: [entry.heading, ...entry.rows.map(row => row.text), ...(entry.skillItems ?? []).map(item => item.text)].join("\n"),
    })),
  ];
}

/**
 * The block a citation belongs to. An auditor reading the canonical evidence sees row ids and an
 * entry's own id as well as its block id, and a row quoted under any of them is the same evidence
 * as that row quoted under its block's, so a citation is judged by the block it came from.
 * `entryIds` are the library's entry ids, so a bare one can be recognised.
 */
export function evidenceBlockId(id: string, entryIds?: ReadonlySet<string>): string {
  const match = /^(entry:.+):(?:row|skill):\d+$/.exec(id);
  if (match) return match[1]!;
  return entryIds?.has(id) ? `entry:${id}` : id;
}
