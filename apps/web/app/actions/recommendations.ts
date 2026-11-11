"use server";

import { and, eq, sql } from "drizzle-orm";
import { compileGate } from "@col/core";
import { CATALOGUE_FRESH_DAYS } from "@col/core/catalogue-recommendations";
import { lockAccountScoreInput, type Db } from "@col/db";
import { decisions, jobs, userJobs, userSettings } from "@col/db/schema";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSettingsFor } from "@/lib/settings";
import { recordDecisions } from "@/lib/decisions";
import { actionError, fail, ok, UserFacingError, zUuid, type ActionResult } from "@/lib/validation";

/** Explicit catalogue decision; no implicit follow, paid score or CV build. */
export async function decideCatalogueRecommendation(jobId: string, decision: "apply" | "skip"): Promise<ActionResult> {
  const user = await requireUser();
  if (!zUuid().safeParse(jobId).success || !["apply", "skip"].includes(decision)) return fail("Role not found.");
  try {
    await db().transaction(async tx => {
      await lockAccountScoreInput(tx as unknown as Db, user.id, "exclusive");
      const [job] = await tx.select().from(jobs).where(and(eq(jobs.id, jobId), eq(jobs.shared, true), sql`${jobs.manualOwnerId} is null`, eq(jobs.status, "open")))
        .for("share");
      if (!job || !job.companyId || job.lastSeenAt.getTime() < Date.now() - CATALOGUE_FRESH_DAYS * 86_400_000) throw new UserFacingError("This role is no longer available in recommendations.");
      const refused = await tx.execute(sql`select 1 from companies c where c.id = ${job.companyId}::uuid and (
        exists(select 1 from company_suggestions s where s.user_id = ${user.id}::uuid and s.domain = c.domain and s.status = 'rejected')
        or exists(select 1 from company_subscriptions s where s.user_id = ${user.id}::uuid and s.company_id = c.id and s.status = 'archived'))`);
      if (refused.rows.length) throw new UserFacingError("You have dismissed this company. Review it in Companies before choosing its roles.");
      const [settings, chosen] = await Promise.all([
        getSettingsFor(user.id, tx),
        tx.select({ key: userSettings.key }).from(userSettings).where(and(eq(userSettings.userId, user.id), eq(userSettings.key, "gate"))),
      ]);
      if (!settings.suggestionsEnabled) throw new UserFacingError("Recommendations are off. You can turn them on in Settings.");
      const gate = chosen.length ? settings.gate : { includeKeywords: [], excludeKeywords: [], matchFields: ["title" as const], locationTerms: [], includeRemote: true };
      const evaluated = compileGate(gate).evaluate({ ...job, description: job.descriptionText });
      if (!evaluated.inTable) throw new UserFacingError("Your preferences have changed. Refresh recommendations to see current matches.");
      const [standing] = await tx.select({ decision: decisions.decision }).from(decisions).where(and(eq(decisions.userId, user.id), eq(decisions.jobId, jobId), eq(decisions.superseded, false)));
      if (standing) {
        if (standing.decision === decision) return;
        throw new UserFacingError("You have already reviewed this role. Change your decision in Roles.");
      }
      const [view] = await tx.select({ hidden: userJobs.hidden, archivedAt: userJobs.archivedAt }).from(userJobs)
        .where(and(eq(userJobs.userId, user.id), eq(userJobs.jobId, jobId))).for("update");
      if (view?.hidden || view?.archivedAt) throw new UserFacingError("This role has been dismissed. You can find it in Roles.");
      await tx.insert(userJobs).values({ userId: user.id, jobId, inTable: true, keywordMatched: evaluated.keywordMatched, keywordTerms: evaluated.keywordTerms, locationOk: evaluated.locationOk })
        .onConflictDoNothing();
      await recordDecisions(tx, user.id, [jobId], decision, decision === "skip" ? "Not interested in this recommendation" : "", "Role not found.", { queueFollowUps: false });
    });
  } catch (error) { return actionError(error, "Could not save your choice. Please try again."); }
  // These account pages are dynamic and read decisions on navigation. Revalidating
  // here also refreshes the current discovery tree, removing the card before its
  // acknowledgement can be read. The action returns the durable saved choice instead.
  return ok();
}
