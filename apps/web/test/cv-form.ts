import { eq } from "drizzle-orm";
import { cvDrafts, type Db } from "@col/db";
import { cvDraftEditBaseHash } from "@/lib/cv-edit-base";

/** Attach the saved editor base that the real CV page supplies to an action test form. */
export async function withCvEditBase(database: Db, id: string, form: FormData): Promise<FormData> {
  const [draft] = await database.select({ content: cvDrafts.content, targetingBrief: cvDrafts.targetingBrief,
    revision: cvDrafts.revision }).from(cvDrafts).where(eq(cvDrafts.id, id)).limit(1);
  if (draft) {
    form.set("baseRevision", String(draft.revision));
    form.set("baseEditHash", cvDraftEditBaseHash(draft.content, draft.targetingBrief));
  }
  return form;
}
