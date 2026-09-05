import { z } from "zod";

export const CareersLinksSchema = z.object({
  candidates: z
    .array(
      z.object({
        url: z.string(),
        confidence: z.number(),
        reason: z.string(),
      }),
    )
    .max(8),
});

export const PageClassificationSchema = z.object({
  kind: z.enum(["listing", "landing", "other"]),
  nextHopUrl: z.string().nullable().optional(),
  confidence: z.number(),
});

export const RecipeSchema = z.object({
  listItem: z.string(),
  title: z.string(),
  link: z.string(),
  location: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
});

export const ExtractPostingsSchema = z.object({
  postings: z
    .array(
      z.object({
        title: z.string(),
        url: z.string(),
        location: z.string().nullable().optional(),
        department: z.string().nullable().optional(),
      }),
    )
    .max(500),
  recipe: RecipeSchema.nullable().optional(),
  confidence: z.number(),
});

export const DescriptionSchema = z.object({
  descriptionText: z.string(),
  salaryText: z.string().nullable().optional(),
  employmentType: z.string().nullable().optional(),
  remote: z.boolean().nullable().optional(),
});

export const FitScoreSchema = z.object({
  score: z.number(),
  verdict: z.enum(["strong", "possible", "unlikely"]),
  rationale: z.string(),
  flags: z.array(z.string()).max(8).optional(),
});

export const ReasonTagsSchema = z.object({
  tags: z.array(z.string()).max(8),
  proposedNewTags: z.array(z.object({ tag: z.string(), description: z.string() })).max(4).optional(),
});

export const ProfileSchema = z.object({
  markdown: z.string(),
  openQuestions: z.array(z.object({ id: z.string(), question: z.string() })).max(6).optional(),
});

export const FilterSuggestionsSchema = z.object({
  suggestions: z
    .array(
      z.object({
        type: z.enum(["keyword_include", "keyword_exclude", "location", "pause_company", "hide_threshold"]),
        value: z.record(z.string(), z.unknown()),
        rationale: z.string(),
        evidence: z.array(z.string()).max(8),
      }),
    )
    .max(8),
});

export const CompanyProfileSchema = z.object({
  oneLiner: z.string(),
  sector: z.string(),
  subSector: z.string().nullable().optional(),
  businessModel: z.string().nullable().optional(),
  customerType: z.string().nullable().optional(),
  stage: z.string().nullable().optional(),
  sizeBand: z.string().nullable().optional(),
  hqCountry: z.string().nullable().optional(),
  geographies: z.array(z.string()).max(12).optional(),
  tags: z.array(z.string()).max(12).optional(),
});

export const CompanySuggestionsSchema = z.object({
  candidates: z
    .array(
      z.object({
        name: z.string(),
        homepageUrl: z.string(),
        similarTo: z.array(z.string()).max(6).optional(),
        rationale: z.string(),
        confidence: z.number(),
      }),
    )
    .max(30),
});

export type CareersLinksOutput = z.infer<typeof CareersLinksSchema>;
export type PageClassificationOutput = z.infer<typeof PageClassificationSchema>;
export type ExtractPostingsOutput = z.infer<typeof ExtractPostingsSchema>;
export type DescriptionOutput = z.infer<typeof DescriptionSchema>;
export type FitScoreOutput = z.infer<typeof FitScoreSchema>;
export type ReasonTagsOutput = z.infer<typeof ReasonTagsSchema>;
export type ProfileOutput = z.infer<typeof ProfileSchema>;
export type FilterSuggestionsOutput = z.infer<typeof FilterSuggestionsSchema>;
export type CompanyProfileOutput = z.infer<typeof CompanyProfileSchema>;
export type CompanySuggestionsOutput = z.infer<typeof CompanySuggestionsSchema>;
