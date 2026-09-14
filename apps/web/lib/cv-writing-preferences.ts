import { desc } from "drizzle-orm";
import { cvLibraries } from "@christopher/db";
import { resolveCvWritingPreferences } from "@christopher/core/cv";
import { db } from "./db";
import { getSettings } from "./settings";

export async function getCvWritingPreferences() {
  const settings = await getSettings();
  if (settings.cvWritingPreferences) return settings.cvWritingPreferences;
  const [library] = await db().select({ content: cvLibraries.content }).from(cvLibraries).orderBy(desc(cvLibraries.version)).limit(1);
  return resolveCvWritingPreferences(undefined, library?.content);
}
