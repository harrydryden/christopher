import { z } from "zod";

const ColourSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex colour.");
export const CvThemeSchema = z.object({
  version: z.literal(1), primary: ColourSchema, background: ColourSchema,
  surface: ColourSchema, pill: ColourSchema, introPanel: z.boolean(), skillPills: z.boolean(),
});
export type CvTheme = z.infer<typeof CvThemeSchema>;
export const CV_THEMES: Record<string, CvTheme> = {
  Navy: { version: 1, primary: "#234766", background: "#ffffff", surface: "#eff4f8", pill: "#e3edf5", introPanel: true, skillPills: true },
  Gold: { version: 1, primary: "#ffcc00", background: "#ffffff", surface: "#ffffff", pill: "#fff2b3", introPanel: true, skillPills: true },
  Forest: { version: 1, primary: "#285447", background: "#fffefa", surface: "#eef4ee", pill: "#dfebe2", introPanel: true, skillPills: true },
  Plum: { version: 1, primary: "#653d64", background: "#fffcff", surface: "#f5eef5", pill: "#eedfee", introPanel: true, skillPills: true },
};
export const DEFAULT_CV_THEME = CV_THEMES.Navy!;
/** Black or white always provides readable contrast against an opaque sRGB fill. */
export function cvForeground(colour: string): string {
  const rgb = [1, 3, 5].map(i => parseInt(colour.slice(i, i + 2), 16) / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
  return luminance > 0.179 ? "#000000" : "#ffffff";
}
