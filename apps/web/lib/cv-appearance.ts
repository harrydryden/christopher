import { desc, sql } from "drizzle-orm";
import { cvLibraries } from "@christopher/db";
import { CvThemeSchema, DEFAULT_CV_THEME } from "@christopher/core/cv";
import { db } from "./db";
import { getSettings } from "./settings";

/** Preserve the saved library appearance until a default is saved in Settings. */
export async function getDefaultCvAppearance() {
  const settings = await getSettings();
  if (settings.cvTheme) return settings.cvTheme;
  const [library] = await db().select({ theme: sql<unknown>`${cvLibraries.content}->'theme'` })
    .from(cvLibraries).orderBy(desc(cvLibraries.version)).limit(1);
  const parsed = CvThemeSchema.safeParse(library?.theme);
  return parsed.success ? { ...parsed.data, skillPills: true } : DEFAULT_CV_THEME;
}
