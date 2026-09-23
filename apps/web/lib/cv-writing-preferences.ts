import { and, desc, eq } from "drizzle-orm";
import { cvLibraries } from "@ava/db";
import { resolveCvWritingPreferences } from "@ava/core/cv";
import { db } from "./db";
import { getSettingsFor } from "./settings";

export async function getCvWritingPreferences(userId: string) {
  const settings = await getSettingsFor(userId);
  if (settings.cvWritingPreferences) return settings.cvWritingPreferences;
  const [library] = await db().select({ content: cvLibraries.content }).from(cvLibraries).where(and(eq(cvLibraries.userId, userId))).orderBy(desc(cvLibraries.version)).limit(1);
  return resolveCvWritingPreferences(undefined, library?.content);
}
