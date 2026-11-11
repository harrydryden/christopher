import { desc, eq } from "drizzle-orm";
import { cvApplicationContexts } from "@col/db/schema";
import { db } from "@/lib/db";

/** Small owned metadata for explicit identity reuse; wording never decides whether two roles match. */
export async function getCvOpportunityChoices(userId: string) {
  return db().select({ contextId: cvApplicationContexts.id, companyName: cvApplicationContexts.companyName,
    jobTitle: cvApplicationContexts.jobTitle, createdAt: cvApplicationContexts.createdAt })
    .from(cvApplicationContexts).where(eq(cvApplicationContexts.userId, userId))
    .orderBy(desc(cvApplicationContexts.createdAt), desc(cvApplicationContexts.id)).limit(50);
}
