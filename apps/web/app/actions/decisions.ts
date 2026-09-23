"use server";

import { needsEmailConfirmation, requireUser, requireVerifiedUser } from "@/lib/auth";

import { and, eq, inArray, sql } from "drizzle-orm";
import { decisions, jobEvents, tagVocabulary, userJobs } from "@ava/db/schema";
import { evaluateLocation } from "@ava/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { enqueue, enqueueMany } from "@/lib/enqueue";
import { cvBuildQuote, cvQuoteButtonLine } from "@/lib/cv-quote";
import { VERIFY_SENTENCE } from "@/components/VerifyNotice";
import { fetchRoleDetails, locationReasonText, type CvQuoteVM, type RoleDetailsVM } from "@/lib/queries/jobs";
import { getSettingsFor } from "@/lib/settings";
import { countStandingDecisions, queueFilterSuggestionsOnCrossing, recordDecision, restoreDismissedApplications, withdrawLiveApplications } from "@/lib/decisions";
import { actionError, fail, ok, UserFacingError, zUuid, type ActionResult } from "@/lib/validation";

export type RoleDetailsResult = { ok: true; details: RoleDetailsVM } | { ok: false; error: string };

const ROLE_DETAILS_FAILED = "Could not load this role. Please try again.";

/**
 * What building a CV for this role would cost this account, for the panel's own button.
 *
 * Only a shortlisted role with no CV yet is offered a build in the panel, so only that role pays
 * for the quote; everything else is a link to the application it already has. An account with no
 * Library gets no price, because its next step is the Library rather than the budget.
 */
async function panelCvQuote(userId: string, row: { stage: string; job: { id: string } }): Promise<CvQuoteVM | null> {
  if (row.stage !== "shortlisted") return null;
  const quote = await cvBuildQuote(userId, row.job.id);
  return quote.hasLibrary ? { line: cvQuoteButtonLine(quote), refusal: quote.refusal } : null;
}

/**
 * The evidence the review panel needs, for one role this account can see: the stored description
 * the page read deliberately leaves behind, the gate hits behind "why is this here", and the
 * verdict and rationale stored beside the fit score. One round trip, taken when a row expands,
 * which is also where the price of a CV for a shortlisted role comes from.
 */
export async function roleDetails(jobId: string): Promise<RoleDetailsResult> {
  const user = await requireUser();
  const parsed = zUuid().safeParse(jobId);
  if (!parsed.success) return { ok: false, error: "Role not found." };
  try {
    const [row] = await fetchRoleDetails(user.id, [parsed.data]);
    if (!row) return { ok: false, error: "Role not found." };
    // The gate's own terms and the price of a build are independent reads, so the panel waits for
    // the slower of the two rather than for both in turn.
    const [settings, cvQuote] = await Promise.all([getSettingsFor(user.id), panelCvQuote(user.id, row)]);
    // The same rule the gate itself ran: `user_jobs` keeps the verdict, not the terms behind it.
    const evaluated = evaluateLocation(
      { title: row.job.title, location: row.job.location, locations: row.job.locations, remote: row.job.remote },
      settings.gate,
    );
    const hasLocationFilter = settings.gate.locationTerms.some(term => term.trim().length > 0);
    return {
      ok: true,
      details: {
        jobId: row.job.id,
        description: row.job.descriptionText,
        salaryText: row.job.salaryText,
        department: row.job.department,
        employmentType: row.job.employmentType,
        keywordTerms: row.job.keywordTerms,
        fitVerdict: row.job.fitVerdict,
        fitRationale: row.job.fitRationale,
        locationReason: locationReasonText(
          { ok: row.job.locationOk && evaluated.ok, terms: evaluated.terms, remote: evaluated.remote },
          hasLocationFilter,
          row.job.origin === "user" && row.job.addedBy === user.id,
        ),
        cvQuote,
        // `requireVerifiedUser()` in `requestCv` stays the authority; this only stops the button
        // being pressed before the wall is discovered.
        cvBlocked: needsEmailConfirmation(user) ? VERIFY_SENTENCE : null,
      },
    };
  } catch (error) {
    // `actionError` logs the fault and never leaks it; the narrowing keeps this result's shape.
    const failure = actionError(error, ROLE_DETAILS_FAILED);
    return failure.ok ? { ok: false, error: ROLE_DETAILS_FAILED } : failure;
  }
}

/** Spec R-6.1: a reason is required for `skip`, and encouraged (never required) for `apply`. */
const SKIP_REASON_REQUIRED = "Give a reason when you dismiss a role: it is what the ranking learns from.";

const DecideSchema = z
  .object({
    jobId: zUuid(),
    decision: z.enum(["apply", "skip"]).nullable(),
    reason: z.string().max(4000).optional().default(""),
  })
  .refine((v) => v.decision !== "skip" || v.reason.trim().length > 0, { message: SKIP_REASON_REQUIRED, path: ["reason"] });

/**
 * The pages a decision changes: the roles table on Roles and on each company page (whichever the
 * person decided from is re-rendered in the action's own response), the companies list's counts
 * and the applications pipeline. Not the whole layout: nothing in it reads a decision, and
 * invalidating it made every later navigation render in full.
 */
function revalidateDecided(): void {
  revalidatePath("/");
  revalidatePath("/applications");
  revalidatePath("/companies");
  revalidatePath("/companies/[id]", "page");
}

/**
 * Record (or edit) a decision on a role, or undo it when `decision` is null — `recordDecision`,
 * behind this account's authentication. Undoing a dismissal also puts back the application the
 * dismissal withdrew.
 */
export async function decide(jobId: string, decision: "apply" | "skip" | null, reason: string): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = DecideSchema.safeParse({ jobId, decision, reason });
  if (!parsed.success) return fail(parsed.error.issues.find((issue) => issue.path[0] === "reason")?.message ?? "Invalid request.");
  const input = parsed.data;
  const trimmedReason = input.reason.trim();

  try {
    await db().transaction(async (tx) => { await recordDecision(tx, user.id, input.jobId, input.decision, trimmedReason); });
  } catch (err) {
    return actionError(err, "Could not save your decision. Please try again.");
  }

  revalidateDecided();
  return ok();
}

/** Editing a decision's tags re-synthesises the profile from them, which is model work. */
export async function saveDecisionTags(decisionId: string, formData: FormData): Promise<void> {
  const user = await requireVerifiedUser();
  const id = zUuid().parse(decisionId);
  const tags = [...new Set(formData.getAll("tags").map(String))];
  if (tags.length > 30) throw new UserFacingError("Choose at most 30 tags.");
  const accepted = tags.length ? await db().select({ tag: tagVocabulary.tag }).from(tagVocabulary)
    .where(and(eq(tagVocabulary.userId, user.id), inArray(tagVocabulary.tag, tags), eq(tagVocabulary.accepted, true))) : [];
  if (accepted.length !== tags.length) throw new UserFacingError("Choose accepted reason tags from the list.");
  const updated = await db().update(decisions).set({ tags, tagsEdited: true })
    .where(and(eq(decisions.id, id), eq(decisions.userId, user.id), eq(decisions.superseded, false))).returning({ id: decisions.id });
  if (!updated.length) throw new UserFacingError("This decision has changed. Reload before editing its tags.");
  await enqueue("synthesize_profile", { userId: user.id, force: true });
  revalidatePath("/learning");
}

/** Archive is a user preference, independent of source status and future scans. */
export async function archiveRoles(jobIds: string[], archived: boolean): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = z.array(zUuid()).min(1).max(500).safeParse(jobIds);
  if (!parsed.success || typeof archived !== "boolean") return fail("Select between 1 and 500 roles.");
  try {
    await db().transaction(async tx => {
      const ids = [...new Set(parsed.data)];
      const now = new Date();
      // One locking read, one pre-check, one update and one insert, whatever the size of the selection.
      const rows = await tx.select({ jobId: userJobs.jobId, inTable: userJobs.inTable }).from(userJobs)
        .where(and(eq(userJobs.userId, user.id), inArray(userJobs.jobId, ids))).orderBy(userJobs.jobId).for("update");
      if (rows.length !== ids.length) throw new UserFacingError("A selected role no longer exists.");

      // Restoring a role the gate no longer admits is only allowed where a decision holds it.
      const needsDecision = rows.filter(row => !row.inTable).map(row => row.jobId);
      if (!archived && needsDecision.length) {
        const held = await tx.select({ jobId: decisions.jobId }).from(decisions)
          .where(and(eq(decisions.userId, user.id), inArray(decisions.jobId, needsDecision), eq(decisions.superseded, false)));
        if (new Set(held.map(row => row.jobId)).size !== needsDecision.length) {
          throw new UserFacingError("This role no longer matches your criteria. Review it and shortlist it to bring it back, or update your matching preferences.");
        }
      }

      await tx.update(userJobs).set({ archivedAt: archived ? now : null, updatedAt: now })
        .where(and(eq(userJobs.userId, user.id), inArray(userJobs.jobId, ids)));

      const payload = JSON.stringify({ action: archived ? "archived" : "restored", actor: "user" });
      await tx.execute(sql`insert into job_events (job_id, user_id, type, payload)
        select v.job_id, ${user.id}::uuid, 'updated', ${payload}::jsonb
        from user_jobs v
        where v.user_id = ${user.id}::uuid and v.job_id in (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})`);
    });
  } catch (error) { return actionError(error, "Could not update the archive."); }
  revalidateDecided();
  return ok();
}

/** Spec R-6.1: the same limit the group toolbar enforces; the archive takes 500 because it writes far less. */
const MAX_GROUP_DECISION = 100;

const DecideGroupSchema = z
  .object({
    jobIds: z.array(zUuid()).min(1).max(MAX_GROUP_DECISION),
    decision: z.enum(["apply", "skip"]).nullable(),
    reason: z.string().max(4000).optional().default(""),
  })
  .refine((v) => v.decision !== "skip" || v.reason.trim().length > 0, { message: SKIP_REASON_REQUIRED, path: ["reason"] });

/**
 * Decide a group of roles at once with one shared reason, or undo the group when `decision` is null.
 * The result is exactly what the same roles decided one at a time would leave behind — one active
 * decision row each superseding the previous one, one `decided` event each, and the same tasks —
 * written set-based in a single transaction. All or nothing: a role that is not this account's, or
 * a group skip without a reason, writes nothing at all rather than leaving part of the group saved.
 */
export async function decideRoles(jobIds: string[], decision: "apply" | "skip" | null, reason: string): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = DecideGroupSchema.safeParse({ jobIds, decision, reason });
  if (!parsed.success) {
    const reasonIssue = parsed.error.issues.find((issue) => issue.path[0] === "reason");
    return fail(reasonIssue?.message ?? `Select between 1 and ${MAX_GROUP_DECISION} roles.`);
  }
  const input = parsed.data;
  const trimmedReason = input.reason.trim();

  try {
    await db().transaction(async tx => {
      const ids = [...new Set(input.jobIds)].sort();
      const idList = sql.join(ids.map(id => sql`${id}::uuid`), sql`, `);
      const now = new Date();

      // One locking read in a stable order, like archiveRoles: the whole group or none of it.
      const rows = await tx.select({ jobId: userJobs.jobId, inTable: userJobs.inTable, archivedAt: userJobs.archivedAt }).from(userJobs)
        .where(and(eq(userJobs.userId, user.id), inArray(userJobs.jobId, ids))).orderBy(userJobs.jobId).for("update");
      if (rows.length !== ids.length) throw new UserFacingError("A selected role no longer exists.");
      const before = await countStandingDecisions(tx, user.id);

      // Undo keeps the audit record: the previous decision is superseded, never deleted.
      const superseded = await tx.update(decisions).set({ superseded: true })
        .where(and(eq(decisions.userId, user.id), inArray(decisions.jobId, ids), eq(decisions.superseded, false)))
        .returning({ jobId: decisions.jobId, decision: decisions.decision });

      if (input.decision === null) {
        // What undoing each dismissal puts back, as `decide` does for one role.
        await restoreDismissedApplications(tx, user.id, superseded.filter(row => row.decision === "skip" && row.jobId).map(row => row.jobId!));
        // A role the gate no longer admits was only in the table because a decision held it.
        const drops = rows.filter(row => !row.inTable && !row.archivedAt).map(row => row.jobId);
        if (drops.length) {
          await tx.update(userJobs).set({ archivedAt: now, updatedAt: now })
            .where(and(eq(userJobs.userId, user.id), inArray(userJobs.jobId, drops)));
          await tx.insert(jobEvents).values(drops.map(jobId => ({
            jobId, userId: user.id, type: "updated" as const,
            payload: { action: "archived", actor: "system", reason: "No longer matches your criteria" },
          })));
        }
        await tx.insert(jobEvents).values(ids.map(jobId => ({ jobId, userId: user.id, type: "decided" as const, payload: { decision: null } })));
        await enqueue("synthesize_profile", { userId: user.id, force: true }, tx);
        return;
      }

      await tx.update(userJobs).set({ archivedAt: null, updatedAt: now })
        .where(and(eq(userJobs.userId, user.id), inArray(userJobs.jobId, ids)));

      // One insert … select writes the whole group with its denormalised snapshot, so the learning
      // corpus survives job or company deletion exactly as a single decision's does.
      const inserted = await tx.execute<{ id: string; job_id: string }>(sql`
        insert into decisions (user_id, job_id, decision, reason, job_title, company_name, job_location, job_department, description_snippet, fit_score_at_decision)
        select ${user.id}::uuid, j.id, ${input.decision}, ${trimmedReason}, j.title, coalesce(c.name, ''), j.location, j.department,
               left(j.description_text, 300), v.fit_score
        from jobs j
        join user_jobs v on v.job_id = j.id and v.user_id = ${user.id}::uuid
        left join companies c on c.id = j.company_id
        where j.id in (${idList})
        returning id, job_id`);
      const insertedRows = [...inserted.rows];
      if (insertedRows.length !== ids.length) throw new UserFacingError("A selected role no longer exists.");

      const payload = JSON.stringify({ decision: input.decision, reason: trimmedReason });
      await tx.execute(sql`insert into job_events (job_id, user_id, type, payload)
        select v.job_id, ${user.id}::uuid, 'decided', ${payload}::jsonb
        from user_jobs v
        where v.user_id = ${user.id}::uuid and v.job_id in (${idList})`);

      if (input.decision === "apply") await enqueueMany("score_job", ids.map(jobId => ({ userId: user.id, jobId })), tx);
      if (input.decision === "skip") await withdrawLiveApplications(tx, user.id, ids);
      if (trimmedReason) await enqueueMany("tag_reason", insertedRows.map(row => ({ decisionId: row.id })), tx);
      await enqueue("synthesize_profile", { userId: user.id, force: false }, tx);
      await queueFilterSuggestionsOnCrossing(tx, user.id, before);
    });
  } catch (error) {
    return actionError(error, "Could not save your decisions. Please try again.");
  }

  revalidateDecided();
  return ok();
}
