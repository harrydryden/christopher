import { CV_LIMITS, CV_SECTION_ORDER } from "./cv-format";
export * from "./cv-format";
import { z } from "zod";

import { CvThemeSchema, DEFAULT_CV_THEME } from "./cv-theme";
export * from "./cv-theme";

const SkillItemsSchema = z.array(z.string().trim().min(1).max(80).refine(value => !/[\r\n]/.test(value), "Each skill must be a single line.")).min(1).max(20)
  .refine(items => new Set(items.map(item => item.toLowerCase())).size === items.length, "Remove repeated skills.");

const LinkedInSchema = z.string().max(300).refine(value => {
  if (!value) return true;
  try { const url = new URL(value); return url.protocol === "https:" && (url.hostname === "linkedin.com" || url.hostname === "www.linkedin.com") && url.pathname.startsWith("/in/"); } catch { return false; }
}, "Enter an https://www.linkedin.com/in/ profile URL").optional();

const CareerDateSchema = z.string().regex(/^(?:|\d{4}(?:-(?:0[1-9]|1[0-2]))?)$/, "Use YYYY-MM, YYYY, or leave unknown dates blank.");
export function industryDescriptions(value = ""): string[] {
  const seen = new Set<string>();
  return value.split(",").map(item => item.trim()).filter(item => {
    const key = item.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  });
}
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
/** Industry context is shared by jobs at the same company in the employment editor. */
export function updateEmploymentIndustries(employment: Employment[], jobId: string, descriptions: string): Employment[] {
  const company = employment.find(job => job.id === jobId)?.company;
  if (!company) return employment;
  return employment.map(job => normalise(job.company) === normalise(company) ? { ...job, industryDescriptions: descriptions } : job);
}
const normalise = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
const employmentKey = (job: Employment) => JSON.stringify([normalise(job.company), normalise(job.jobTitle), job.startDate, job.endDate, job.current]);
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function careerDateLabel(value: string): string {
  return /^\d{4}-\d{2}$/.test(value) ? `${months[Number(value.slice(5)) - 1]} ${value.slice(0, 4)}` : value;
}
export function employmentHeading(job: Employment): string {
  const dates = [careerDateLabel(job.startDate), job.current ? "Present" : careerDateLabel(job.endDate)].filter(Boolean).join(" – ");
  return [job.jobTitle, job.company, dates].filter(Boolean).join(" · ");
}

export const CvEntrySchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(["experience", "education", "skill", "interest"]),
  status: z.enum(["draft", "active", "inactive"]).optional(),
  heading: z.string().trim().min(1).max(250),
  details: z.string().trim().min(1).max(40000),
  skillItems: SkillItemsSchema.optional(),
  // Confirmation belongs to the exact wording, so editing or removing a row cannot transfer it.
  confirmedResponsibilities: z.array(z.string().min(1).max(40000)).max(20).optional(),
  company: z.string().trim().max(160).optional(),
  employmentId: z.string().min(1).max(100).optional(),
  roleId: z.string().min(1).max(100).optional(),
});
export const CvLibrarySchema = z.object({
  name: z.string().trim().min(1).max(120),
  contact: z.string().trim().max(500),
  linkedinUrl: LinkedInSchema,
  profile: z.string().trim().max(5000),
  stylePreferences: z.string().max(4000).optional(),
  preferredWording: z.string().max(12000).optional(),
  theme: CvThemeSchema.optional(),
  structuredExperience: z.literal(true).optional(),
  employment: z.array(EmploymentSchema).max(100).optional(),
  entries: z.array(CvEntrySchema).min(1).max(100),
}).superRefine((library, ctx) => {
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
  sections: z.array(z.object({ entryId: z.string(), skillItems: SkillItemsSchema.optional(), industryDescriptions: z.array(z.string().min(1).max(120)).max(2).optional(), bullets: z.array(z.string().min(1).max(CV_LIMITS.bulletCharacters)).min(1).max(CV_LIMITS.bulletsPerSection) })).min(1).max(20),
  gaps: z.array(z.string().max(500)).max(12),
});
export type CvPlan = z.infer<typeof CvPlanSchema>;
export const CvContentSchema = z.object({
  theme: CvThemeSchema.optional(),
  linkedinUrl: LinkedInSchema,
  name: z.string().min(1).max(120), contact: z.string().max(500), summary: z.string().min(1).max(CV_LIMITS.summaryCharacters),
  sections: z.array(z.object({ entryId: z.string(), kind: CvEntrySchema.shape.kind, skillItems: SkillItemsSchema.optional(), heading: z.string().min(1).max(250), industryDescriptions: z.array(z.string().min(1).max(120)).max(2).optional(), bullets: z.array(z.string().min(1).max(CV_LIMITS.bulletCharacters)).min(1).max(CV_LIMITS.bulletsPerSection) }).refine(section => !section.skillItems || section.kind === "skill", "Individual skills belong to skill sections only")).min(1).max(20),
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
  return CvContentSchema.parse({ theme: library.theme ?? DEFAULT_CV_THEME, name: library.name, contact: library.contact, linkedinUrl: library.linkedinUrl, summary: plan.summary,
    sections: library.entries.flatMap(e => selected.has(e.id) ? [selected.get(e.id)!] : []), gaps: plan.gaps });
}

/** Legacy headings can supply a company, but never imply that two jobs are the same. */
export function companyForEntry(entry: z.infer<typeof CvEntrySchema>): string {
  if (entry.company !== undefined) return entry.company;
  if (entry.kind !== "experience") return "";
  const parts = entry.heading.split("·").map(part => part.trim());
  return parts.length === 3 ? parts[1]! : "";
}

/** Keep the stored library granular; give generation one evidence set per explicit role. */
export function groupCvLibrary(library: CvLibrary): CvLibrary {
  CvLibrarySchema.parse(library);
  const eligible = library.entries.flatMap(entry => {
    const usable = eligibleCvEvidence(entry);
    return usable && (!entry.roleId || library.entries.some(parent => parent.id === entry.roleId && isActiveEvidence(parent))) ? [usable] : [];
  });
  if (!eligible.length) throw new Error("Activate at least one evidence block and confirm the responsibilities you want to use, then save your library before building a CV.");
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

/** Editing/removing a row clears its confirmation; other rows retain theirs. */
export function updateResponsibilityRows(entry: CvLibrary["entries"][number], rows: string[]): CvLibrary["entries"][number] {
  const details = rows.join("\n");
  const retained = new Set(responsibilityRows(details));
  return { ...entry, details, confirmedResponsibilities: (entry.confirmedResponsibilities ?? []).filter(row => retained.has(row)) };
}

/** One eligibility rule for CV generation and role qualification. Missing confirmation is unconfirmed. */
export function eligibleCvEvidence(entry: CvLibrary["entries"][number]): CvLibrary["entries"][number] | undefined {
  if (!isActiveEvidence(entry)) return undefined;
  if (entry.kind !== "experience") return entry;
  const confirmed = new Set(entry.confirmedResponsibilities ?? []);
  const rows = responsibilityRows(entry.details).filter(row => confirmed.has(row));
  return rows.length ? { ...entry, details: rows.join("\n"), confirmedResponsibilities: [...new Set(rows)] } : undefined;
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

/** Consolidate editable evidence without truncating historical wording or changing snapshots. */
export function consolidateExperience(library: CvLibrary): CvLibrary {
  const history = migrateEmploymentHistory(library);
  const migrated = { ...history, entries: history.entries.map(entry => ({ ...entry, status: entry.status ?? "active" as const })) };
  if (migrated.structuredExperience) return migrated;
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
    return [{ ...members[0]!, status: members.every(entry => entry.status === members[0]!.status) ? members[0]!.status : "draft" as const, heading: employmentHeading(job), details: rows.join("\n"), confirmedResponsibilities: rows.filter(row => confirmed.has(row)) }];
  });
  return { ...migrated, structuredExperience: true, entries: [...entries, ...migrated.entries.filter(entry => entry.kind !== "experience")] };
}

/** Missing statuses belong to legacy snapshots, where evidence was active by default. */
export function isActiveEvidence(entry: CvLibrary["entries"][number]): boolean {
  return entry.status === undefined || entry.status === "active";
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
