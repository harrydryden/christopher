import { z } from "zod";

const LinkedInSchema = z.string().max(300).refine(value => {
  if (!value) return true;
  try { const url = new URL(value); return url.protocol === "https:" && (url.hostname === "linkedin.com" || url.hostname === "www.linkedin.com") && url.pathname.startsWith("/in/"); } catch { return false; }
}, "Enter an https://www.linkedin.com/in/ profile URL").optional();

const CareerDateSchema = z.string().regex(/^(?:|\d{4}(?:-(?:0[1-9]|1[0-2]))?)$/, "Use YYYY-MM, YYYY, or leave unknown dates blank.");
export const EmploymentSchema = z.object({
  id: z.string().min(1).max(100),
  company: z.string().trim().min(1).max(160),
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
  heading: z.string().trim().min(1).max(250),
  details: z.string().trim().min(1).max(40000),
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
  summary: z.string().min(1).max(1800),
  sections: z.array(z.object({ entryId: z.string(), bullets: z.array(z.string().min(1).max(650)).min(1).max(6) })).min(1).max(20),
  gaps: z.array(z.string().max(500)).max(12),
});
export type CvPlan = z.infer<typeof CvPlanSchema>;
export const CvContentSchema = z.object({
  linkedinUrl: LinkedInSchema,
  name: z.string().min(1).max(120), contact: z.string().max(500), summary: z.string().min(1).max(1800),
  sections: z.array(z.object({ entryId: z.string(), kind: CvEntrySchema.shape.kind, heading: z.string().min(1).max(250), bullets: z.array(z.string().min(1).max(650)).min(1).max(6) })).min(1).max(20),
  gaps: z.array(z.string().max(500)).max(12),
});
export type CvContent = z.infer<typeof CvContentSchema>;

/** Names, employers, dates and qualifications come from the user's library, never model metadata. */
export function materialiseCv(library: CvLibrary, plan: CvPlan): CvContent {
  const seen = new Set<string>();
  const seenJobs = new Set<string>();
  const selected = new Map(plan.sections.map(section => {
    const entry = library.entries.find(e => e.id === section.entryId);
    if (!entry || seen.has(entry.id)) throw new Error("CV contains unknown or repeated evidence references");
    seen.add(entry.id);
    if (entry.employmentId && seenJobs.has(entry.employmentId)) throw new Error("CV repeats the same employment record");
    if (entry.employmentId) seenJobs.add(entry.employmentId);
    return [entry.id, { ...section, kind: entry.kind, heading: evidenceHeading(library, entry) }];
  }));
  return CvContentSchema.parse({ name: library.name, contact: library.contact, linkedinUrl: library.linkedinUrl, summary: plan.summary,
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
  if (library.employment !== undefined) {
    const experience = employmentCompanyGroups(library.employment).flatMap(group => group.jobs).flatMap(job => {
      const members = library.entries.filter(entry => entry.employmentId === job.id);
      if (!members.length) return [];
      return [{ ...members[0]!, heading: employmentHeading(job), details: combineEvidence(members) }];
    });
    return { ...library, entries: [...experience, ...library.entries.filter(entry => entry.kind !== "experience")] };
  }
  return { ...library, entries: library.entries.filter(entry => !entry.roleId).map(role => {
    const members = library.entries.filter(entry => entry.id === role.id || entry.roleId === role.id);
    const details = combineEvidence(members);
    return { ...role, details };
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
  const migrated = migrateEmploymentHistory(library);
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
    return [{ ...members[0]!, heading: employmentHeading(job), details: rows.join("\n") }];
  });
  return { ...migrated, structuredExperience: true, entries: [...entries, ...migrated.entries.filter(entry => entry.kind !== "experience")] };
}
