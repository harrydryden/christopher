/**
 * The CV theme's values and pure helpers, with no zod import, so a client component can read the
 * presets and colours without shipping the validator. `cv-theme.ts` holds the schema and re-exports
 * everything here; `CvTheme` there is checked to be exactly this type.
 */
import { CV_PAGE_LIMITS } from "./cv-format";

/**
 * AVA is the renderer's own face (the standard Helvetica every PDF viewer carries).
 * Arial embeds Liberation Sans, its metric-compatible open equivalent, so it looks the same on
 * every machine. The names are what the user chooses in Settings.
 */
export const CV_FONTS = ["AVA", "Arial"] as const;
export type CvFont = (typeof CV_FONTS)[number];
export const DEFAULT_CV_FONT: CvFont = "AVA";
/** The name the AVA face was stored under before the product was renamed. */
export const LEGACY_CV_FONT = "Christopher";
/** A resolved theme: what `CvThemeSchema` produces, with the font and page limit filled in. */
export type CvTheme = {
  version: 1;
  primary: string;
  background: string;
  surface: string;
  pill: string;
  introPanel: boolean;
  skillPills: boolean;
  font: CvFont;
  maxPages: number;
};
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
/** Black or white always provides readable contrast against an opaque sRGB fill. */
export function cvForeground(colour: string): string {
  const rgb = [1, 3, 5].map(i => parseInt(colour.slice(i, i + 2), 16) / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
  return luminance > 0.179 ? "#000000" : "#ffffff";
}
