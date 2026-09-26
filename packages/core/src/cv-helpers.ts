/**
 * The CV contract's pure helpers: reading, tagging, grouping and consolidating a Library, and the
 * display order of a CV. Nothing here imports zod, so the Library and CV editors can use them in the
 * browser without shipping the validator (about 23 KB gzipped). `cv.ts` holds the schemas and
 * re-exports everything public here, so server code keeps importing `@ava/core/cv`.
 *
 * Types come from `cv.ts` as type-only imports, which the compiler erases: at run time this module
 * depends on `cv-format` alone.
 */
import { CV_SECTION_ORDER } from "./cv-format";
import type { CvContent, CvLibrary, Employment } from "./cv";

/** The one email shape the Library accepts; the schema refuses anything else. */
export const EMAIL = /^[^\s@·|;,]+@[^\s@·|;,]+\.[^\s@·|;,]+$/u;

export function industryDescriptions(value = ""): string[] {
  const seen = new Set<string>();
  return value.split(",").map(item => item.trim()).filter(item => {
    const key = item.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  });
}

/** Industry context is shared by jobs at the same company in the employment editor. */
export function updateEmploymentIndustries(employment: Employment[], jobId: string, descriptions: string): Employment[] {
  const company = employment.find(job => job.id === jobId)?.company;
  if (!company) return employment;
  return employment.map(job => normalise(job.company) === normalise(company) ? { ...job, industryDescriptions: descriptions } : job);
}
/** Case- and space-insensitive comparison key; not part of the public contract. */
export const normalise = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
/** What makes two employment records the same job; not part of the public contract. */
export const employmentKey = (job: Employment) => JSON.stringify([normalise(job.company), normalise(job.jobTitle), job.startDate, job.endDate, job.current]);
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function careerDateLabel(value: string): string {
  return /^\d{4}-\d{2}$/.test(value) ? `${months[Number(value.slice(5)) - 1]} ${value.slice(0, 4)}` : value;
}
export function employmentHeading(job: Employment): string {
  const dates = [careerDateLabel(job.startDate), job.current ? "Present" : careerDateLabel(job.endDate)].filter(Boolean).join(" – ");
  return [job.jobTitle, job.company, dates].filter(Boolean).join(" · ");
}

/**
 * What a responsibility row is *for*. Six facets, because an entry that only ever says what
 * someone was responsible for cannot evidence anything a reviewer weighs: the problem, what
 * changed, by how much, what shipped, and how they work are the parts a CV assessment rewards and
 * the parts a blank textarea never asks for.
 *
 * A facet is a classification of a row, kept per exact row text like `confirmedResponsibilities`
 * — but unlike confirmation it is not an assertion that the row is true, so it survives an edit
 * (see `updateResponsibilityRows`). A row carries as many of the six as it serves: one narrative
 * is often the problem somebody solved *and* the figure it moved, and a row that is both should
 * count as both rather than force a choice between them.
 */
export const EVIDENCE_FACETS = ["responsibility", "problem", "outcome", "metric", "milestone", "style"] as const;
export type EvidenceFacet = (typeof EVIDENCE_FACETS)[number];
/** What each facet is called where a row's types are shown or chosen. Plural: a row may carry several. */
export const EVIDENCE_FACET_LABELS: Readonly<Record<EvidenceFacet, string>> = {
  responsibility: "Responsibilities",
  problem: "Problems solved",
  outcome: "Outcomes",
  metric: "Metrics moved",
  milestone: "Milestones reached",
  style: "Working style",
};
/**
 * The facets in the order a Library asks for them: what a reviewer weighs most, first.
 *
 * It is the order `LIBRARY_FACET_WEIGHTS` scores them in, written out here because the editor
 * needs it and the scoring module cannot be loaded in a browser. `rulesLibraryReview` reports its
 * missing facets in exactly this order, and a test in `library-review.test.ts` holds the two
 * together so they cannot drift.
 */
export const EVIDENCE_FACETS_BY_NEED: readonly EvidenceFacet[] = ["outcome", "metric", "responsibility", "problem", "milestone", "style"];
/** One question per facet, answerable in a line. This is what a missing facet is shown as. */
export const EVIDENCE_FACET_PROMPTS: Readonly<Record<EvidenceFacet, string>> = {
  responsibility: "What were you responsible for, and for whom?",
  problem: "What problem or constraint were you there to solve?",
  outcome: "What changed as a result?",
  metric: "By how much, or how many?",
  milestone: "What did you ship or complete, and when?",
  style: "How do you work with other people to get this done?",
};

/**
 * Whether a block is evidence at all — not something the person sets.
 *
 * A job that is in employment history is active by being there; evidence whose job has been
 * removed is archived by `retainArchivedEvidence` and excluded from everything. An earlier release
 * offered a third state, Draft, and the libraries it wrote still carry it: a stored `"draft"` is
 * read as `"active"` (see `CvEntrySchema`), and nothing is written as one again.
 */
export type CvEvidenceStatus = "active" | "inactive";

/** The most a CV's contact line holds: `CvContentSchema.contact`'s limit. */
export const CONTACT_LINE_LIMIT = 500;

/** Structural rather than `Pick<CvLibrary, …>`: the library schema's own refinement calls these. */
interface ContactFields { contact?: string; email?: string; phone?: string; location?: string }

/**
 * The contact line a CV header prints: email · phone · location, then whatever else the person
 * keeps in the free-text line. Blank parts are skipped, so a library saved before the three fields
 * existed prints exactly what it always did.
 */
export function contactLine(library: ContactFields): string {
  return [library.email, library.phone, library.location, library.contact]
    .map(part => (part ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" · ");
}

const CONTACT_SEPARATOR = /\s*(?:[·•|;\n]|\s-\s)\s*/u;
const PHONE = /^\+?[\d\s().-]+$/u;

/**
 * A library written before contact details had fields of their own, opened with them: an email
 * address or a phone number the old line carried as a part of its own moves to its field, and
 * everything else stays in `contact` — which the editor shows as "Other contact details".
 *
 * Nothing is guessed. A part moves only when it is the one part of its kind and is nothing but an
 * address or a number; a location cannot be told from any other phrase, so it is never moved. A
 * library that already has any of the three fields has been through this, or through the editor,
 * and is returned as it is — which also makes this safe to run twice.
 */
export function splitLegacyContact<T extends ContactFields>(library: T): T {
  if (library.email !== undefined || library.phone !== undefined || library.location !== undefined) return library;
  const raw = typeof library.contact === "string" ? library.contact : "";
  if (!raw.trim()) return library;
  const parts = raw.split(CONTACT_SEPARATOR).map(part => part.trim()).filter(Boolean);
  const emails = parts.filter(part => EMAIL.test(part));
  const phones = parts.filter(part => PHONE.test(part) && (part.match(/\d/g) ?? []).length >= 7);
  const email = emails.length === 1 ? emails[0] : undefined;
  const phone = phones.length === 1 ? phones[0] : undefined;
  if (!email && !phone) return library;
  const rest = parts.filter(part => part !== email && part !== phone).join(" · ");
  const upgraded = { ...library, ...(email ? { email } : {}), ...(phone ? { phone } : {}), contact: rest };
  // Rejoining with " · " can lengthen a tightly punctuated line. An upgrade must never leave a
  // library that was savable unsavable, so a line the cap would then refuse is left as it was.
  return contactLine(upgraded).length > CONTACT_LINE_LIMIT ? library : upgraded;
}

/** Legacy headings can supply a company, but never imply that two jobs are the same. */
export function companyForEntry(entry: CvLibrary["entries"][number]): string {
  if (entry.company !== undefined) return entry.company;
  if (entry.kind !== "experience") return "";
  const parts = entry.heading.split("·").map(part => part.trim());
  return parts.length === 3 ? parts[1]! : "";
}

function parseCareerDate(value: string): string {
  if (/^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/.test(value)) return value;
  const match = value.match(/^([a-z]+)\s+(\d{4})$/i);
  const month = match ? months.findIndex(m => m.toLowerCase() === match[1]!.slice(0, 3).toLowerCase()) : -1;
  return match && month >= 0 ? `${match[2]}-${String(month + 1).padStart(2, "0")}` : "";
}

/** Upgrade only editable libraries. Original draft snapshots remain immutable and readable. */
export function migrateEmploymentHistory(library: CvLibrary): CvLibrary {
  if (library.employment !== undefined) return library;
  const employment: Employment[] = [];
  const links = new Map<string, string>();
  for (const entry of library.entries.filter(entry => entry.kind === "experience" && !entry.roleId)) {
    const parts = entry.heading.split("·").map(part => part.trim());
    const range = parts.length === 3 ? parts[2]!.match(/^(.*?)\s*(?:[–—]|-(?=[A-Za-z\d]))\s*(present|current|now|[A-Za-z]+\s+\d{4}|\d{4}(?:-\d{2})?)$/i) : null;
    const job: Employment = { id: entry.id, company: companyForEntry(entry) || (parts.length === 2 ? parts[1]! : ""), jobTitle: parts[0]!, startDate: range ? parseCareerDate(range[1]!.trim()) : "", endDate: range ? parseCareerDate(range[2]!) : "", current: !!range && /^(present|current|now)$/i.test(range[2]!) };
    const existing = job.startDate && (job.endDate || job.current) ? employment.find(item => employmentKey(item) === employmentKey(job)) : undefined;
    if (!existing) employment.push(job);
    links.set(entry.id, existing?.id ?? job.id);
  }
  return { ...library, employment, entries: library.entries.map(entry => {
    const { company: _company, roleId: _roleId, ...rest } = entry;
    return entry.kind === "experience" ? { ...rest, employmentId: links.get(entry.roleId ?? entry.id) } : rest;
  }) };
}

/** Resolve canonical metadata for generation and role qualification, leaving the library label alone. */
export function evidenceHeading(library: CvLibrary, entry: CvLibrary["entries"][number]): string {
  const job = library.employment?.find(job => job.id === entry.employmentId);
  return job ? employmentHeading(job) : entry.heading;
}

/** A single canonical text representation also serves existing scoring and CV consumers. */
export function responsibilityRows(details: string): string[] {
  return details.split(/\r?\n/).map(line => line.replace(/^\s*[•*\-]\s+/, "").trim()).filter(Boolean);
}

/**
 * The rows of an entry that are evidence, rather than the subsidiary labels
 * `consolidateExperience` inserts to head a merged block. A label supports no claim on its own —
 * `eligibleCvEvidence` already treats it that way — so it is not scored, not prompted for and not
 * counted against the person.
 */
export function evidenceRows(entry: CvLibrary["entries"][number]): string[] {
  return responsibilityRows(entry.details).filter(row => !row.endsWith(":"));
}

/** Unique, in the canonical order, and nothing that is not one of the six. */
function canonicalFacets(values: readonly unknown[]): EvidenceFacet[] {
  return EVIDENCE_FACETS.filter(facet => values.includes(facet));
}

/**
 * The types a row serves, as the person tagged them, in canonical order. Empty when they have not
 * said.
 *
 * Reads a library that has not been through the schema as happily as one that has: an earlier
 * release stored a row's single type as a bare string, and a stored library is handed straight to
 * a reader in more than one place, so the string is read as a one-item array here rather than
 * relying on every caller to have parsed first.
 */
export function rowFacets(entry: CvLibrary["entries"][number], row: string): EvidenceFacet[] {
  const stored = entry.rowFacets?.[row] as readonly EvidenceFacet[] | EvidenceFacet | undefined;
  return canonicalFacets(typeof stored === "string" ? [stored] : stored ?? []);
}

/**
 * Tag a row with the types it serves, or clear it with an empty array. Unknown rows are tagged
 * anyway; `tidyRowFacets` sweeps.
 */
export function setRowFacets(entry: CvLibrary["entries"][number], row: string, facets: readonly EvidenceFacet[]): CvLibrary["entries"][number] {
  const { rowFacets: previous, ...rest } = entry;
  const next = { ...previous };
  const kept = canonicalFacets(facets);
  if (kept.length) next[row] = kept; else delete next[row];
  return Object.keys(next).length ? { ...rest, rowFacets: next } : rest;
}

/**
 * Drop facets whose row no longer exists, and the empty map that leaves behind. A no-op otherwise,
 * down to the object identity, so running it on open and on save costs nothing and changes no
 * stored library that is already tidy.
 */
export function tidyRowFacets(entry: CvLibrary["entries"][number]): CvLibrary["entries"][number] {
  const facets = entry.rowFacets;
  if (!facets) return entry;
  const rows = new Set(responsibilityRows(entry.details));
  // An empty list is not a tag: a row the person untagged goes, rather than being stored as one
  // the schema would then refuse.
  const kept = Object.entries(facets).filter(([row, tags]) => rows.has(row) && (Array.isArray(tags) ? tags.length > 0 : !!tags));
  if (kept.length && kept.length === Object.keys(facets).length) return entry;
  const { rowFacets: _dropped, ...rest } = entry;
  return kept.length ? { ...rest, rowFacets: Object.fromEntries(kept) } : rest;
}

/**
 * Editing/removing a row clears its confirmation; other rows retain theirs.
 *
 * A facet, unlike a confirmation, is carried across the edit. Confirmation is the person asserting
 * that this exact wording is true of them, so rewording it has to be re-asserted; a facet only
 * classifies what the row is for, and fixing a typo in an outcome leaves it an outcome. A row
 * carrying several types carries all of them across, for the same reason. Rows are matched by
 * their text first and by position second, which is how the editor rewrites them.
 */
export function updateResponsibilityRows(entry: CvLibrary["entries"][number], rows: string[]): CvLibrary["entries"][number] {
  const details = rows.join("\n");
  const previous = responsibilityRows(entry.details);
  const next = responsibilityRows(details);
  const retained = new Set(next);
  const facets: Record<string, EvidenceFacet[]> = {};
  for (const [index, row] of next.entries()) {
    const byText = rowFacets(entry, row);
    const carried = byText.length ? byText : rowFacets(entry, previous[index] ?? "");
    if (carried.length) facets[row] = carried;
  }
  const { rowFacets: _previous, ...rest } = entry;
  const updated = { ...rest, details, confirmedResponsibilities: (entry.confirmedResponsibilities ?? []).filter(row => retained.has(row)) };
  return Object.keys(facets).length ? { ...updated, rowFacets: facets } : updated;
}

/** One eligibility rule for CV generation and role qualification. Missing confirmation is unconfirmed. */
export function eligibleCvEvidence(entry: CvLibrary["entries"][number]): CvLibrary["entries"][number] | undefined {
  if (!isActiveEvidence(entry)) return undefined;
  if (entry.kind !== "experience") return entry;
  const confirmed = new Set(entry.confirmedResponsibilities ?? []);
  const all = responsibilityRows(entry.details);
  const isLabel = (row: string) => row.endsWith(":");
  // A subsidiary label (see consolidateExperience) stays when it heads a confirmed row, so the
  // writer and the reviewer can tell which entity an achievement belongs to; a bare label cannot
  // support a claim on its own and goes with its unconfirmed rows.
  const rows = all.filter((row, index) => {
    if (confirmed.has(row)) return true;
    if (!isLabel(row)) return false;
    for (const following of all.slice(index + 1)) {
      if (isLabel(following)) return false;
      if (confirmed.has(following)) return true;
    }
    return false;
  });
  const evidence = rows.filter(row => !isLabel(row));
  // Tidied, so the tags of the rows that were dropped go with them: `rowFacets` is keyed by row
  // text, and what this returns is what generation is given — unconfirmed wording must not reach
  // it through the bookkeeping either.
  return evidence.length ? tidyRowFacets({ ...entry, details: rows.join("\n"), confirmedResponsibilities: [...new Set(evidence)] }) : undefined;
}

export function compareEmploymentDates(a: Employment, b: Employment): number {
  return Number(b.current) - Number(a.current)
    || (b.endDate || b.startDate).localeCompare(a.endDate || a.startDate)
    || b.startDate.localeCompare(a.startDate)
    || a.jobTitle.localeCompare(b.jobTitle);
}

export function employmentCompanyGroups(employment: Employment[]): { company: string; jobs: Employment[] }[] {
  const groups = new Map<string, { company: string; jobs: Employment[] }>();
  for (const job of employment) {
    const key = normalise(job.company);
    const group = groups.get(key) ?? { company: job.company, jobs: [] };
    group.jobs.push(job); groups.set(key, group);
  }
  return [...groups.values()].map(group => ({ ...group, jobs: group.jobs.sort(compareEmploymentDates) }))
    .sort((a, b) => compareEmploymentDates(a.jobs[0]!, b.jobs[0]!) || a.company.localeCompare(b.company));
}

/**
 * Mark the library as facet-aware and sweep facets whose row is gone.
 *
 * There is nothing to migrate — a legacy library simply carries no facets, and tagging is the
 * person's to do — so this only raises the flag and tidies, exactly where `structuredExperience`
 * is raised. Rows are the key, so a removed or rewritten row must not leave its facet behind.
 */
function facetedLibrary(library: CvLibrary): CvLibrary {
  return { ...library, facetedRows: true, entries: library.entries.map(tidyRowFacets) };
}

/** Consolidate editable evidence without truncating historical wording or changing snapshots. */
export function consolidateExperience(library: CvLibrary): CvLibrary {
  const history = migrateEmploymentHistory(library);
  // Active unless it has been archived: a block stored without a status, and one an earlier
  // release stored as a draft, are both evidence of a job the person still lists.
  const migrated = { ...history, entries: history.entries.map(entry => ({ ...entry, status: entry.status === "inactive" ? "inactive" as const : "active" as const })) };
  if (migrated.structuredExperience) return facetedLibrary(migrated);
  const entries = (migrated.employment ?? []).flatMap(job => {
    const members = migrated.entries.filter(entry => entry.kind === "experience" && entry.employmentId === job.id);
    if (!members.length) return [];
    const rows: string[] = [];
    const seen = new Set<string>();
    for (const member of members) {
      // Preserve subsidiary labels as context: they may qualify unconfirmed statements.
      if (members.length > 1 && member !== members[0]) rows.push(member.heading + ":");
      for (const row of responsibilityRows(member.details)) {
        const key = normalise(row);
        if (!seen.has(key)) { rows.push(row); seen.add(key); }
      }
    }
    const confirmed = new Set(members.flatMap(member => member.confirmedResponsibilities ?? []));
    // Facets are keyed by row text, so merging the members' maps carries each row's own tags into
    // the consolidated block rather than keeping only the first member's. Two members that tagged
    // the same wording differently were both right about it: the merged row carries the union.
    const facets: Record<string, EvidenceFacet[]> = {};
    for (const row of rows) {
      const union = canonicalFacets(members.flatMap(member => rowFacets(member, row)));
      if (union.length) facets[row] = union;
    }
    return [{ ...members[0]!, status: members.every(entry => entry.status === members[0]!.status) ? members[0]!.status : "active" as const, heading: employmentHeading(job), details: rows.join("\n"), confirmedResponsibilities: rows.filter(row => confirmed.has(row)), rowFacets: facets }];
  });
  return facetedLibrary({ ...migrated, structuredExperience: true, entries: [...entries, ...migrated.entries.filter(entry => entry.kind !== "experience")] });
}

/**
 * Evidence unless it has been archived. A block with no status at all belongs to a legacy
 * snapshot, where evidence was active by default, and reads the same way.
 *
 * This is the question asked of a *parsed* library, where the only two answers are the two
 * `CvEvidenceStatus` names. Ask `isActiveStoredEvidence` of anything that has not been parsed.
 */
export function isActiveEvidence(entry: CvLibrary["entries"][number]): boolean {
  return entry.status === undefined || entry.status === "active";
}

/**
 * The same question, asked of a row of `cv_libraries.content` or `cv_drafts.library_snapshot`
 * that has not been through `CvEntrySchema`.
 *
 * Stored JSON can still say `"draft"`, which the schema reads as `"active"` and which the Library
 * shows as evidence. A reader handed stored content compares against the one status that means
 * archived, so a block nobody has re-saved since the release that wrote it is not silently read
 * as archived — which would drop it from the Library's evidence, keep it out of the review pass
 * and send a gap answer somewhere other than the block it belongs to.
 */
export function isActiveStoredEvidence(entry: CvLibrary["entries"][number]): boolean {
  return entry.status !== "inactive";
}

/** Imports/removals retain a recoverable inactive record instead of deleting evidence. */
export function retainArchivedEvidence(previous: CvLibrary | undefined, next: CvLibrary): CvLibrary {
  if (!previous) return next;
  const existing = consolidateExperience(previous);
  const removed = existing.entries.filter(entry => !next.entries.some(candidate => candidate.id === entry.id || (entry.employmentId && candidate.employmentId === entry.employmentId)));
  const employment = [...(next.employment ?? [])];
  for (const entry of removed) {
    const job = existing.employment?.find(job => job.id === entry.employmentId);
    if (job && !employment.some(candidate => candidate.id === job.id)) employment.push(job);
  }
  return { ...next, employment, entries: [...next.entries, ...removed.map(entry => ({ ...entry, status: "inactive" as const }))] };
}

/** A shared display order keeps editing and PDF output aligned without changing stored IDs. */
export function cvDisplaySections(content: CvContent) {
  const order = CV_SECTION_ORDER;
  return content.sections.map((section, index) => ({ section, index }))
    .sort((a, b) => order[a.section.kind] - order[b.section.kind]);
}
