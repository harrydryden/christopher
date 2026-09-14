import { z } from "zod";

export const CvWritingPreferencesSchema = z.object({
  stylePreferences: z.string().max(4000),
  preferredWording: z.string().max(12000),
});
export type CvWritingPreferences = z.infer<typeof CvWritingPreferencesSchema>;

export function resolveCvWritingPreferences(stored: unknown, library?: { stylePreferences?: string; preferredWording?: string } | null): CvWritingPreferences {
  const parsed = CvWritingPreferencesSchema.safeParse(stored);
  return parsed.success ? parsed.data : {
    stylePreferences: library?.stylePreferences ?? "",
    preferredWording: library?.preferredWording ?? "",
  };
}
