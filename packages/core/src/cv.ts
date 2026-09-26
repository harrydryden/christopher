export * from "./cv-budget";
export * from "./cv-writing-preferences";
import { CV_LIMITS } from "./cv-format";
export * from "./cv-format";
import { z } from "zod";

import { CvThemeSchema, DEFAULT_CV_THEME } from "./cv-theme";
export * from "./cv-theme";
import {
  CONTACT_LINE_LIMIT, EMAIL, EVIDENCE_FACETS, contactLine, companyForEntry, consolidateExperience,
  eligibleCvEvidence, employmentCompanyGroups, employmentHeading, employmentKey, evidenceHeading,
  industryDescriptions, isActiveEvidence, normalise, responsibilityRows, type EvidenceFacet,
} from "./cv-helpers";
// The zod-free helpers, re-exported so every server caller keeps one import. `EMAIL`, `normalise`
// and `employmentKey` stay internal, as they were before the split.
export {
  CONTACT_LINE_LIMIT, EVIDENCE_FACETS, EVIDENCE_FACETS_BY_NEED, EVIDENCE_FACET_LABELS, EVIDENCE_FACET_PROMPTS,
  companyForEntry, compareEmploymentDates, consolidateExperience, contactLine, cvDisplaySections,
  eligibleCvEvidence, employmentCompanyGroups, employmentHeading, evidenceHeading, evidenceRows,
  industryDescriptions, isActiveEvidence, isActiveStoredEvidence, migrateEmploymentHistory,
  responsibilityRows, retainArchivedEvidence, rowFacets, setRowFacets, splitLegacyContact,
  tidyRowFacets, updateEmploymentIndustries, updateResponsibilityRows,
  type CvEvidenceStatus, type EvidenceFacet,
} from "./cv-helpers";

const SkillItemsSchema = z.array(z.string().trim().min(1).max(80).refine(value => !/[\r\n]/.test(value), "Each skill must be a single line.")).min(1).max(20)
  .refine(items => new Set(items.map(item => item.toLowerCase())).size === items.length, "Remove repeated skills.");
export const CvPlanSourceRefSchema = z.object({ sourceId: z.string().min(1).max(220), quote: z.string().trim().min(1).max(1600) });

const LinkedInSchema = z.string().max(300).refine(value => {
  if (!value) return true;
  try { const url = new URL(value); return url.protocol === "https:" && (url.hostname === "linkedin.com" || url.hostname === "www.linkedin.com") && url.pathname.startsWith("/in/"); } catch { return false; }
}, "Enter an https://www.linkedin.com/in/ profile URL").optional();

const WebsiteSchema = z.string().trim().max(500).refine(value => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}, "Enter a valid https:// or http:// website URL.").optional();

/**
 * The three contact details a CV header carries, each its own field. `contact` stays alongside them
 * as the free-text line every library saved before these fields existed wrote everything into: it
 * is never dropped, only read as "Other contact details" after them. See `contactLine`.
 */
const singleLine = (max: number) => z.string().trim().max(max).refine(value => !/[\r\n]/.test(value), "Keep this on one line.");
const EmailSchema = singleLine(254).refine(value => !value || EMAIL.test(value), "Enter an email address like name@example.com.").optional();
const PhoneSchema = singleLine(40).optional();
const LocationSchema = singleLine(120).optional();

const CareerDateSchema = z.string().regex(/^(?:|\d{4}(?:-(?:0[1-9]|1[0-2]))?)$/, "Use YYYY-MM, YYYY, or leave unknown dates blank.");
const IndustryDescriptionsSchema = z.string().trim().max(1200).refine(value => {
  const descriptions = industryDescriptions(value);
  return descriptions.length <= 10 && descriptions.every(item => item.length <= 120);
}, "Use up to 10 comma-separated industry descriptions, each no longer than 120 characters.").optional();
export const EmploymentSchema = z.object({
  id: z.string().min(1).max(100),
  company: z.string().trim().min(1).max(160),
  industryDescriptions: IndustryDescriptionsSchema,
  jobTitle: z.string().trim().min(1).max(160),
  startDate: CareerDateSchema,
  endDate: CareerDateSchema,
  current: z.boolean(),
}).superRefine((job, ctx) => {
  if (job.current && job.endDate) ctx.addIssue({ code: "custom", path: ["endDate"], message: "Current jobs cannot have an end date." });
  if (job.startDate && job.endDate && job.startDate.padEnd(7, "-01") > job.endDate.padEnd(7, "-12")) ctx.addIssue({ code: "custom", path: ["endDate"], message: "End date must not be before start date." });
  if (employmentHeading(job).length > 250) ctx.addIssue({ code: "custom", message: "Shorten the company or job title so the CV heading is at most 250 characters." });
});
export type Employment = z.infer<typeof EmploymentSchema>;

/**
 * The types a row carries, unique and in the canonical `EVIDENCE_FACETS` order.
 *
 * Input order is nobody's business — a multi-select hands them over in the order they were ticked
 * — so it is normalised here and the written form is always sorted and deduplicated. A library
 * written before a row could carry more than one type stored a bare string; it is read as a
 * one-item array, which is what keeps every stored library and every draft snapshot parsing.
 * Anything outside the vocabulary is left for the enum to refuse: a tag the Library cannot show is
 * a bug, not bookkeeping.
 */
const RowFacetsSchema = z.preprocess(value => {
  const listed = typeof value === "string" ? [value] : value;
  if (!Array.isArray(listed)) return listed;
  return [
    ...EVIDENCE_FACETS.filter(facet => listed.includes(facet)),
    ...listed.filter(item => !EVIDENCE_FACETS.includes(item as EvidenceFacet)),
  ];
}, z.array(z.enum(EVIDENCE_FACETS)).min(1).max(EVIDENCE_FACETS.length));

export const CvEntrySchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(["experience", "education", "skill", "interest"]),
  // A block stored as a draft by an earlier release is active: the status is no longer the
  // person's to set, so reading it as anything else would strand evidence nobody can reactivate.
  status: z.preprocess(value => value === "draft" ? "active" : value, z.enum(["active", "inactive"])).optional(),
  heading: z.string().trim().min(1).max(250),
  details: z.string().trim().min(1).max(40000),
  skillItems: SkillItemsSchema.optional(),
  // Confirmation belongs to the exact wording, so editing or removing a row cannot transfer it.
  confirmedResponsibilities: z.array(z.string().min(1).max(40000)).max(20).optional(),
  // Keyed by exact row text, like the confirmations above. Stale keys are dropped by
  // `tidyRowFacets` rather than rejected here, so a save is never blocked by leftover bookkeeping.
  rowFacets: z.record(z.string().min(1).max(40000), RowFacetsSchema)
    .refine(facets => Object.keys(facets).length <= 20, "Keep up to 20 responsibilities and outcomes per job.").optional(),
  company: z.string().trim().max(160).optional(),
  employmentId: z.string().min(1).max(100).optional(),
  roleId: z.string().min(1).max(100).optional(),
});
export const CvLibrarySchema = z.object({
  name: z.string().trim().min(1).max(120),
  /** Other contact details: the one free-text line every library had before the fields below. */
  contact: z.string().trim().max(500),
  email: EmailSchema,
  phone: PhoneSchema,
  location: LocationSchema,
  linkedinUrl: LinkedInSchema,
  websiteUrl: WebsiteSchema,
  /** The bio. Stored under its original key, so every saved library and draft snapshot still parses. */
  profile: z.string().trim().max(5000),
  stylePreferences: z.string().max(4000).optional(),
  preferredWording: z.string().max(12000).optional(),
  theme: CvThemeSchema.optional(),
  structuredExperience: z.literal(true).optional(),
  /**
   * Version flag, as `structuredExperience` is: set once the library has been through the
   * facet-aware editor. Absent means nobody has been offered the facets yet, which is different
   * from having been offered them and tagged nothing — the Library needs to tell those apart.
   * A legacy library without it parses unchanged.
   */
  facetedRows: z.literal(true).optional(),
  employment: z.array(EmploymentSchema).max(100).optional(),
  entries: z.array(CvEntrySchema).min(1).max(100),
}).superRefine((library, ctx) => {
  if (contactLine(library).length > CONTACT_LINE_LIMIT) ctx.addIssue({ code: "custom", path: ["contact"], message: `Shorten the contact details so they fit on one line of ${CONTACT_LINE_LIMIT} characters.` });
  if (library.employment) {
    if (new Set(library.employment.map(job => job.id)).size !== library.employment.length) ctx.addIssue({ code: "custom", message: "Employment IDs must be unique." });
    if (new Set(library.employment.map(employmentKey)).size !== library.employment.length) ctx.addIssue({ code: "custom", message: "This company, job title and date range already exist in employment history." });
  }
  if (library.structuredExperience) {
    const jobs = new Set<string>();
    for (const [index, entry] of library.entries.entries()) {
      if (entry.kind !== "experience") continue;
      if (jobs.has(entry.employmentId!)) ctx.addIssue({ code: "custom", path: ["entries", index], message: "Only one responsibilities and outcomes block is allowed per job." });
      jobs.add(entry.employmentId!);
      if (responsibilityRows(entry.details).length > 20) ctx.addIssue({ code: "custom", path: ["entries", index, "details"], message: "Keep up to 20 responsibilities and outcomes per job. Combine related rows before saving." });
    }
  }
  for (const [index, entry] of library.entries.entries()) {
    if (entry.skillItems && entry.kind !== "skill") ctx.addIssue({ code: "custom", path: ["entries", index, "skillItems"], message: "Individual skills belong to skill blocks only." });
    if (library.employment !== undefined) {
      if (entry.roleId || entry.company !== undefined) ctx.addIssue({ code: "custom", path: ["entries", index], message: "Company and role must come from employment history." });
      if (entry.kind === "experience" ? !library.employment.some(job => job.id === entry.employmentId) : !!entry.employmentId) ctx.addIssue({ code: "custom", path: ["entries", index, "employmentId"], message: "Select an employment record for experience only." });
      continue;
    }
    if (entry.employmentId) ctx.addIssue({ code: "custom", message: "Employment history is missing." });
    if (!entry.roleId) continue;
    const role = library.entries.find(candidate => candidate.id === entry.roleId);
    if (entry.kind !== "experience" || !role || role.kind !== "experience" || role.roleId || !companyForEntry(entry) || companyForEntry(entry).toLowerCase() !== companyForEntry(role).toLowerCase()) {
      ctx.addIssue({ code: "custom", message: "Select an existing role at the same company for each linked experience block." });
    }
  }
}).refine(l => new Set(l.entries.map(e => e.id)).size === l.entries.length, "Library entry IDs must be unique");
export type CvLibrary = z.infer<typeof CvLibrarySchema>;
export const CvPlanSchema = z.object({
  summary: z.string().min(1).max(CV_LIMITS.summaryCharacters),
  summarySources: z.array(CvPlanSourceRefSchema).max(8).optional(),
  sections: z.array(z.object({ entryId: z.string(), skillItems: SkillItemsSchema.optional(), industryDescriptions: z.array(z.string().min(1).max(120)).max(2).optional(), bullets: z.array(z.string().min(1).max(CV_LIMITS.bulletCharacters)).min(1).max(CV_LIMITS.bulletsPerSection), bulletSources: z.array(z.array(CvPlanSourceRefSchema).min(1).max(8)).max(CV_LIMITS.bulletsPerSection).optional() })).min(1).max(20),
  gaps: z.array(z.string().max(500)).max(12),
});
export type CvPlan = z.infer<typeof CvPlanSchema>;
export const CvContentSchema = z.object({
  fitNotes: z.array(z.string().max(500)).max(50).optional(),
  theme: CvThemeSchema.optional(),
  linkedinUrl: LinkedInSchema,
  websiteUrl: WebsiteSchema,
  name: z.string().min(1).max(120), contact: z.string().max(500), summary: z.string().min(1).max(CV_LIMITS.summaryCharacters), summarySources: z.array(CvPlanSourceRefSchema).max(8).optional(),
  sections: z.array(z.object({ entryId: z.string(), kind: CvEntrySchema.shape.kind, skillItems: SkillItemsSchema.optional(), heading: z.string().min(1).max(250), industryDescriptions: z.array(z.string().min(1).max(120)).max(2).optional(), bullets: z.array(z.string().min(1).max(CV_LIMITS.bulletCharacters)).min(1).max(CV_LIMITS.bulletsPerSection), bulletSources: z.array(z.array(CvPlanSourceRefSchema).min(1).max(8)).max(CV_LIMITS.bulletsPerSection).optional() }).refine(section => !section.skillItems || section.kind === "skill", "Individual skills belong to skill sections only")).min(1).max(20),
  gaps: z.array(z.string().max(500)).max(12),
});
export type CvContent = z.infer<typeof CvContentSchema>;

/** Names, employers, dates and qualifications come from the user's library, never model metadata. */
export function materialiseCv(library: CvLibrary, plan: CvPlan): CvContent {
  const seen = new Set<string>();
  const seenJobs = new Set<string>();
  const selected = new Map(plan.sections.map(section => {
    const entry = library.entries.find(e => e.id === section.entryId);
    if (!entry || !eligibleCvEvidence(entry) || seen.has(entry.id)) throw new Error("CV contains unknown, unconfirmed or repeated evidence references");
    seen.add(entry.id);
    if (entry.employmentId && seenJobs.has(entry.employmentId)) throw new Error("CV repeats the same employment record");
    if (entry.employmentId) seenJobs.add(entry.employmentId);
    if (section.skillItems && (entry.kind !== "skill" || !entry.skillItems)) throw new Error("CV contains skills without structured source evidence");
    if (entry.skillItems && !section.skillItems?.length) throw new Error("Select individual skills from the source skill items");
    const selectedSkills = section.skillItems?.map(item => {
      const stored = entry.skillItems?.find(source => normalise(source) === normalise(item));
      if (!stored) throw new Error("CV contains a skill not in the evidence library");
      return stored;
    });
    const job = library.employment?.find(item => item.id === entry.employmentId);
    const available = industryDescriptions(job?.industryDescriptions);
    const selectedIndustries = [...new Set((section.industryDescriptions ?? []).map(description => {
      const stored = available.find(item => normalise(item) === normalise(description));
      if (!stored) throw new Error("CV contains an industry description not in employment history");
      return stored;
    }))];
    return [entry.id, { ...section, ...(selectedSkills ? { skillItems: selectedSkills } : {}), ...(selectedIndustries.length ? { industryDescriptions: selectedIndustries } : {}), kind: entry.kind, heading: evidenceHeading(library, entry) }];
  }));
  return CvContentSchema.parse({ theme: library.theme ?? DEFAULT_CV_THEME, name: library.name, contact: contactLine(library), linkedinUrl: library.linkedinUrl, websiteUrl: library.websiteUrl, summary: plan.summary, summarySources: plan.summarySources,
    sections: library.entries.flatMap(e => selected.has(e.id) ? [selected.get(e.id)!] : []), gaps: plan.gaps });
}


/** Keep the stored library granular; give generation one evidence set per explicit role. */
export function groupCvLibrary(library: CvLibrary): CvLibrary {
  CvLibrarySchema.parse(library);
  const eligible = library.entries.flatMap(entry => {
    const usable = eligibleCvEvidence(entry);
    return usable && (!entry.roleId || library.entries.some(parent => parent.id === entry.roleId && isActiveEvidence(parent))) ? [usable] : [];
  });
  if (!eligible.length) throw new Error("Confirm at least one responsibility or outcome in a job's evidence, then save your library before building a CV.");
  library = { ...library, employment: library.employment?.filter(job => eligible.some(entry => entry.employmentId === job.id)), entries: eligible };
  if (library.employment !== undefined) {
    const experience = employmentCompanyGroups(library.employment).flatMap(group => group.jobs).flatMap(job => {
      const members = library.entries.filter(entry => entry.employmentId === job.id);
      if (!members.length) return [];
      const details = combineEvidence(members);
      return [{ ...members[0]!, heading: employmentHeading(job), details, confirmedResponsibilities: responsibilityRows(details) }];
    });
    return { ...library, entries: [...experience, ...library.entries.filter(entry => entry.kind !== "experience")] };
  }
  return { ...library, entries: library.entries.filter(entry => !entry.roleId).map(role => {
    const members = library.entries.filter(entry => entry.id === role.id || entry.roleId === role.id);
    const details = combineEvidence(members);
    return role.kind === "experience" ? { ...role, details, confirmedResponsibilities: responsibilityRows(details) } : { ...role, details };
  }) };
}

function combineEvidence(members: CvLibrary["entries"]): string {
  const lines = new Set<string>();
  return members.map(entry => entry.details.split("\n").filter(line => {
    const key = normalise(line.replace(/^[•*\-]\s*/, ""));
    if (!key || lines.has(key)) return false;
    lines.add(key); return true;
  }).join("\n")).filter(Boolean).join("\n\n");
}


/**
 * A stored library, read: parsed, then consolidated. The one entry point that upgrades what an
 * earlier release wrote.
 *
 * Everything that has ever been stored in `cv_libraries.content` comes back through here in
 * today's shape — a row's single facet as a one-item list of types, a block stored as a draft as
 * an active one, one block per job — without a migration and without every reader knowing which
 * release wrote the row it is holding. Deliberately not re-parsed afterwards: consolidation can
 * produce a library the schema refuses (a merge over twenty rows is the one that happens), and
 * that library must still open in the editor that will be used to fix it.
 */
export function normaliseCvLibrary(raw: unknown): CvLibrary {
  return consolidateExperience(CvLibrarySchema.parse(raw));
}

