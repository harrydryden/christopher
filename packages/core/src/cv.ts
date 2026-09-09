import { z } from "zod";

const LinkedInSchema = z.string().max(300).refine(value => {
  if (!value) return true;
  try { const url = new URL(value); return url.protocol === "https:" && (url.hostname === "linkedin.com" || url.hostname === "www.linkedin.com") && url.pathname.startsWith("/in/"); } catch { return false; }
}, "Enter an https://www.linkedin.com/in/ profile URL").optional();

export const CvEntrySchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(["experience", "education", "skill", "interest"]),
  heading: z.string().trim().min(1).max(250),
  details: z.string().trim().min(1).max(8000),
  company: z.string().trim().max(160).optional(),
  roleId: z.string().min(1).max(100).optional(),
});
export const CvLibrarySchema = z.object({
  name: z.string().trim().min(1).max(120),
  contact: z.string().trim().max(500),
  linkedinUrl: LinkedInSchema,
  profile: z.string().trim().max(5000),
  stylePreferences: z.string().max(4000).optional(),
  preferredWording: z.string().max(12000).optional(),
  entries: z.array(CvEntrySchema).min(1).max(100),
}).superRefine((library, ctx) => {
  for (const entry of library.entries) {
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
  const selected = new Map(plan.sections.map(section => {
    const entry = library.entries.find(e => e.id === section.entryId);
    if (!entry || seen.has(entry.id)) throw new Error("CV contains unknown or repeated evidence references");
    seen.add(entry.id);
    return [entry.id, { ...section, kind: entry.kind, heading: entry.heading }];
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
  return { ...library, entries: library.entries.filter(entry => !entry.roleId).map(role => {
    const members = library.entries.filter(entry => entry.id === role.id || entry.roleId === role.id);
    const lines = new Set<string>();
    const details = members.map(entry => entry.details.split("\n").filter(line => {
      const key = line.trim().replace(/^[•*\-]\s*/, "").toLowerCase();
      if (!key) return false;
      if (lines.has(key)) return false;
      lines.add(key); return true;
    }).join("\n")).filter(Boolean).join("\n\n");
    return { ...role, details };
  }) };
}
