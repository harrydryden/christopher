import { z } from "zod";
import { CV_PAGE_LIMITS } from "./cv-format";
import { CV_FONTS, DEFAULT_CV_FONT, DEFAULT_CV_THEME, LEGACY_CV_FONT, type CvTheme } from "./cv-theme-values";
export { CV_FONTS, CV_THEMES, DEFAULT_CV_FONT, DEFAULT_CV_THEME, cvForeground, cvMaxPages, type CvFont, type CvTheme } from "./cv-theme-values";

const ColourSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex colour.");
/**
 * The font and page limit ride with the palette because everything here is captured per CV: the
 * Settings default seeds each new draft's library snapshot, and a saved revision keeps its own copy.
 * Both fields default so that themes stored before they existed still parse.
 */
export const CvThemeSchema = z.object({
  version: z.literal(1), primary: ColourSchema, background: ColourSchema,
  surface: ColourSchema, pill: ColourSchema, introPanel: z.boolean(), skillPills: z.boolean(),
  // Stored themes and saved revisions carry the old name, so it reads as the face it always was.
  font: z.preprocess((font) => (font === LEGACY_CV_FONT ? DEFAULT_CV_FONT : font), z.enum(CV_FONTS)).default(DEFAULT_CV_FONT),
  maxPages: z.number().int().min(CV_PAGE_LIMITS.min).max(CV_PAGE_LIMITS.max).default(CV_PAGE_LIMITS.default),
});
// The zod-free `CvTheme` must stay exactly what the schema produces; either drifting fails typecheck.
// Identity, not mutual assignability: two object types that differ only by an optional property
// are each assignable to the other, so a field added as optional on one side would slip through.
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const themeTypesAgree: Same<z.infer<typeof CvThemeSchema>, CvTheme> = true;
void themeTypesAgree;
/** Stored themes predate the font and page limit; unreadable ones fall back to the default. */
export function resolveCvTheme(value: unknown): CvTheme {
  const parsed = CvThemeSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_CV_THEME;
}
