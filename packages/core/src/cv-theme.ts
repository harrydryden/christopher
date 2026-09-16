import { z } from "zod";
import { CV_PAGE_LIMITS } from "./cv-format";

const ColourSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex colour.");
/**
 * Christopher is the renderer's own face (the standard Helvetica every PDF viewer carries).
 * Arial embeds Liberation Sans, its metric-compatible open equivalent, so it looks the same on
 * every machine. The names are what the user chooses in Settings.
 */
export const CV_FONTS = ["Christopher", "Arial"] as const;
export type CvFont = (typeof CV_FONTS)[number];
export const DEFAULT_CV_FONT: CvFont = "Christopher";
/**
 * The font and page limit ride with the palette because everything here is captured per CV: the
 * Settings default seeds each new draft's library snapshot, and a saved revision keeps its own copy.
 * Both fields default so that themes stored before they existed still parse.
 */
export const CvThemeSchema = z.object({
  version: z.literal(1), primary: ColourSchema, background: ColourSchema,
  surface: ColourSchema, pill: ColourSchema, introPanel: z.boolean(), skillPills: z.boolean(),
  font: z.enum(CV_FONTS).default(DEFAULT_CV_FONT),
  maxPages: z.number().int().min(CV_PAGE_LIMITS.min).max(CV_PAGE_LIMITS.max).default(CV_PAGE_LIMITS.default),
});
export type CvTheme = z.infer<typeof CvThemeSchema>;
const layout = { introPanel: true, skillPills: true, font: DEFAULT_CV_FONT, maxPages: CV_PAGE_LIMITS.default } as const;
export const CV_THEMES: Record<string, CvTheme> = {
  Black: { version: 1, primary: "#000000", background: "#ffffff", surface: "#f2f2f2", pill: "#e6e6e6", ...layout },
  Navy: { version: 1, primary: "#142D46", background: "#ffffff", surface: "#eff4f8", pill: "#e3edf5", ...layout },
  Gold: { version: 1, primary: "#ffcc00", background: "#ffffff", surface: "#ffffff", pill: "#fff2b3", ...layout },
  Forest: { version: 1, primary: "#285447", background: "#fffefa", surface: "#eef4ee", pill: "#dfebe2", ...layout },
  Plum: { version: 1, primary: "#653d64", background: "#fffcff", surface: "#f5eef5", pill: "#eedfee", ...layout },
};
export const DEFAULT_CV_THEME = CV_THEMES.Black!;
/** The page limit a CV, library or theme is held to; absent or legacy themes use the default. */
export function cvMaxPages(theme?: { maxPages?: number } | null): number {
  return theme?.maxPages ?? CV_PAGE_LIMITS.default;
}
/** Stored themes predate the font and page limit; unreadable ones fall back to the default. */
export function resolveCvTheme(value: unknown): CvTheme {
  const parsed = CvThemeSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_CV_THEME;
}
/** Black or white always provides readable contrast against an opaque sRGB fill. */
export function cvForeground(colour: string): string {
  const rgb = [1, 3, 5].map(i => parseInt(colour.slice(i, i + 2), 16) / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
  return luminance > 0.179 ? "#000000" : "#ffffff";
}
