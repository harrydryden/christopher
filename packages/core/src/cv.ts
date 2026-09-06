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
});
export const CvLibrarySchema = z.object({
  name: z.string().trim().min(1).max(120),
  contact: z.string().trim().max(500),
  linkedinUrl: LinkedInSchema,
  profile: z.string().trim().max(5000),
  stylePreferences: z.string().max(4000).optional(),
  preferredWording: z.string().max(12000).optional(),
  entries: z.array(CvEntrySchema).min(1).max(100),
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
