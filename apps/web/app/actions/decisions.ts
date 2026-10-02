"use server";

import { needsEmailConfirmation, requireUser, requireVerifiedUser } from "@/lib/auth";

import { and, eq, inArray, sql } from "drizzle-orm";
import { cvLibraries, decisions, tagVocabulary, userJobs } from "@ava/db/schema";
import { accountCanScore, lockAccountScoreInput } from "@ava/db";
import { evaluateLocation } from "@ava/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { enqueue } from "@/lib/enqueue";
import { cvCreditOffer } from "@/lib/cv-credit";
import { VERIFY_SENTENCE } from "@/components/VerifyNotice";
import { fetchArchiveNotes, fetchRoleDetails, locationReasonText, type CvQuoteVM, type RoleDetailsVM } from "@/lib/queries/jobs";
import { getSettingsFor } from "@/lib/settings";
import { lockRoleView, recordDecisions } from "@/lib/decisions";
import { actionError, fail, ok, UserFacingError, zUuid, type ActionResult } from "@/lib/validation";
import { SKIP_REASON_REQUIRED } from "@/lib/decision-reason";
import { refuseOn, revalidate } from "@/lib/action-helpers";

export type RoleDetailsResult = { ok: true; details: RoleDetailsVM } | { ok: false; error: string };

const ROLE_DETAILS_FAILED = "Could not load this role. Please try again.";

/**
 * A build's credit cost and availability, for the panel's own button.
 *
 * Only a shortlisted role with no CV yet is offered a build in the panel, so only that role pays
 * for the read; everything else is a link to the application it already has. An account with no
 * Library is sent there first.
 */
async function panelCvQuote(userId: string, row: { stage: string; job: { id: string } }): Promise<CvQuoteVM | null> {
  if (row.stage !== "shortlisted") return null;
  const [library] = await db().select({ id: cvLibraries.id }).from(cvLibraries).where(eq(cvLibraries.userId, userId)).limit(1);
  return library ? cvCreditOffer(userId) : null;
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
    // The archive notes come from here too, read only for the row that opened, after the row read
    // has shown this account can see it.
    const [settings, cvQuote, archiveNotes] = await Promise.all([getSettingsFor(user.id), panelCvQuote(user.id, row), fetchArchiveNotes(user.id, row.job.id)]);
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
        archiveNotes,
      },
    };
  } catch (error) {
    // `actionError` logs the fault and never leaks it; the narrowing keeps this result's shape.
    const failure = actionError(error, ROLE_DETAILS_FAILED);
    return failure.ok ? { ok: false, error: ROLE_DETAILS_FAILED } : failure;
  }
}

// Spec R-6.1: a reason is required for `skip`, and encouraged (never required) for `apply`. The
// roles table checks the same rule before sending; this is where it is enforced.
const DecideSchema = z
  .object({
    jobId: zUuid(),
    decision: z.enum(["apply", "skip"]).nullable(),
    reason: z.string().max(4000).optional().default(""),
  })
  .refine((v) => v.decision !== "skip" || v.reason.trim().length > 0, { message: SKIP_REASON_REQUIRED, path: ["reason"] });

/**
 * The pages a decision changes: the roles table on Roles and on each company page, the companies
 * list's counts and the applications pipeline. Any revalidation makes the action's own response
 * carry a fresh render of the page the person decided from, which is why the table never calls
 * `router.refresh()` after a decision: that would render and download the page a second time.
 * Not the whole layout: nothing in it reads a decision.
 */
function revalidateDecided(): void {
  revalidate("/", "/applications", "/companies");
  revalidatePath("/companies/[id]", "page");
}

/**
 * Record (or edit) a decision on a role. Older clients may still send null for Undo; reject it
 * because a tokenless request could erase a newer decision made in another tab.
 */
export async function decide(jobId: string, decision: "apply" | "skip" | null, reason: string): Promise<ActionResult> {
  const user = await requireUser();
  if (decision === null) return fail("This Undo needs the latest decision. Reload roles and use Undo there.");
  const parsed = DecideSchema.safeParse({ jobId, decision, reason });
  if (!parsed.success) return fail(parsed.error.issues.find((issue) => issue.path[0] === "reason")?.message ?? "Invalid request.");
  const input = parsed.data;
  const trimmedReason = input.reason.trim();

  try {
    await db().transaction(async (tx) => { await recordDecisions(tx, user.id, [input.jobId], input.decision, trimmedReason, "Role not found."); });
  } catch (err) {
    return actionError(err, "Could not save your decision. Please try again.");
  }

  revalidateDecided();
  return ok();
}

/** A decision made from Roles returns the exact standing row its recent Undo must compare. */
export async function decideWithUndoToken(jobId: string, decision: "apply" | "skip", reason: string): Promise<{ ok: true; decisionId: string } | { ok: false; error: string }> {
  const user = await requireUser();
  if (decision === null) return { ok: false, error: "This Undo needs the latest decision. Reload roles and use Undo there." };
  const parsed = DecideSchema.safeParse({ jobId, decision, reason });
  if (!parsed.success) return { ok: false, error: parsed.error.issues.find(issue => issue.path[0] === "reason")?.message ?? "Invalid request." };
  try {
    const rows = await db().transaction(tx => recordDecisions(tx, user.id, [parsed.data.jobId], decision, parsed.data.reason.trim(), "Role not found."));
    revalidateDecided();
    return { ok: true, decisionId: rows[0]!.id };
  } catch (error) {
    const failure = actionError(error, "Could not save your decision. Please try again.");
    return failure.ok ? { ok: false, error: "Could not save your decision. Please try again." } : failure;
  }
}

/** The role lock serialises this comparison with decisions in every tab and on Applications. */
export async function undoDecisionIfCurrent(jobId: string, expectedDecisionId: string): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = z.object({ jobId: zUuid(), expectedDecisionId: zUuid() }).safeParse({ jobId, expectedDecisionId });
  if (!parsed.success) return fail("This Undo is out of date. Reload roles to review the latest decision.");
  try {
    await db().transaction(async tx => {
      await lockAccountScoreInput(tx as unknown as ReturnType<typeof db>, user.id, "exclusive");
      if (!await lockRoleView(tx, user.id, parsed.data.jobId)) throw new UserFacingError("Role not found.");
      const [standing] = await tx.select({ id: decisions.id }).from(decisions)
        .where(and(eq(decisions.userId, user.id), eq(decisions.jobId, parsed.data.jobId), eq(decisions.superseded, false)));
      if (standing?.id !== parsed.data.expectedDecisionId)
        throw new UserFacingError("This decision changed in another tab. Reload roles before trying again.");
      await recordDecisions(tx, user.id, [parsed.data.jobId], null, "", "Role not found.");
    });
  } catch (error) { return actionError(error, "Could not undo your decision. Please try again."); }
  revalidateDecided();
  return ok();
}

/**
 * Editing a decision's tags re-synthesises the profile from them, which is model work. The Learning
 * page binds this straight to its form, so a refusal goes back there as a sentence.
 */
export async function saveDecisionTags(decisionId: string, formData: FormData): Promise<void> {
  const result = await saveDecisionTagsSetting(decisionId, { ok: true }, formData);
  if (!result.ok) refuseOn("/learning", result.error);
}

export async function saveDecisionTagsSetting(decisionId: string, _prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireVerifiedUser();
  const parsed = zUuid().safeParse(decisionId);
  const conflict = () => fail("This decision's tags changed since this page loaded. Your selection is still here. Open the latest tags in a new tab and apply the tags you want to keep there.", { href: "/learning", label: "Check the latest tags in a new tab" });
  if (!parsed.success) return conflict();
  const id = parsed.data;
  const tags = [...new Set(formData.getAll("tags").map(String))];
  if (tags.length > 30) return fail("Choose at most 30 tags.");
  let expected: { tags: string[]; tagsEdited: boolean };
  try {
    const value = JSON.parse(String(formData.get("expectedTags") ?? ""));
    if (!value || !Array.isArray(value.tags) || value.tags.some((tag: unknown) => typeof tag !== "string") || typeof value.tagsEdited !== "boolean") return conflict();
    expected = { tags: [...new Set(value.tags as string[])].sort(), tagsEdited: value.tagsEdited };
  } catch { return conflict(); }
  const accepted = tags.length ? await db().select({ tag: tagVocabulary.tag }).from(tagVocabulary)
    .where(and(eq(tagVocabulary.userId, user.id), inArray(tagVocabulary.tag, tags), eq(tagVocabulary.accepted, true))) : [];
  if (accepted.length !== tags.length) return fail("Choose accepted reason tags from the list.");
  const updated = await db().transaction(async tx => {
    await lockAccountScoreInput(tx as unknown as ReturnType<typeof db>, user.id, "exclusive");
    const [standing] = await tx.select({ tags: decisions.tags, tagsEdited: decisions.tagsEdited }).from(decisions)
      .where(and(eq(decisions.id, id), eq(decisions.userId, user.id), eq(decisions.superseded, false))).for("update");
    if (!standing || standing.tagsEdited !== expected.tagsEdited || JSON.stringify([...new Set(standing.tags)].sort()) !== JSON.stringify(expected.tags)) return false;
    const result = await tx.update(decisions).set({ tags, tagsEdited: true })
      .where(and(eq(decisions.id, id), eq(decisions.userId, user.id), eq(decisions.superseded, false))).returning({ id: decisions.id });
    if (result.length && await accountCanScore(tx as unknown as ReturnType<typeof db>, user.id))
      await enqueue("rescore_all", { userId: user.id, onlyInTable: true }, tx);
    if (result.length) await enqueue("synthesize_profile", { userId: user.id, force: true }, tx);
    return result.length > 0;
  });
  if (!updated) return conflict();
  revalidatePath("/learning");
  return { ok: true, nextSnapshot: { expectedTags: JSON.stringify({ tags, tagsEdited: true }) } };
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
 * Decide a group of roles at once with one shared reason. Older clients may still send null for
 * Undo; reject it because a tokenless request could erase newer decisions made in another tab.
 * The same writer as `decide` (`recordDecisions`), so the result is exactly what the same roles
 * decided one at a time would leave behind. All or nothing: a role that is not this account's, or a
 * group skip without a reason, writes nothing at all rather than leaving part of the group saved.
 */
export async function decideRoles(jobIds: string[], decision: "apply" | "skip" | null, reason: string): Promise<ActionResult> {
  const user = await requireUser();
  if (decision === null) return fail("This Undo needs the latest decisions. Reload roles and use Undo there.");
  const parsed = DecideGroupSchema.safeParse({ jobIds, decision, reason });
  if (!parsed.success) {
    const reasonIssue = parsed.error.issues.find((issue) => issue.path[0] === "reason");
    return fail(reasonIssue?.message ?? `Select between 1 and ${MAX_GROUP_DECISION} roles.`);
  }
  const input = parsed.data;
  const trimmedReason = input.reason.trim();

  try {
    await db().transaction(async tx => { await recordDecisions(tx, user.id, input.jobIds, input.decision, trimmedReason); });
  } catch (error) {
    return actionError(error, "Could not save your decisions. Please try again.");
  }

  revalidateDecided();
  return ok();
}

/** The bulk toolbar gets one exact Undo token per saved role. */
export async function decideRolesWithUndoTokens(jobIds: string[], decision: "apply" | "skip", reason: string): Promise<{ ok: true; decisionIds: Record<string, string> } | { ok: false; error: string }> {
  const user = await requireUser();
  if (decision === null) return { ok: false, error: "This Undo needs the latest decisions. Reload roles and use Undo there." };
  const parsed = DecideGroupSchema.safeParse({ jobIds, decision, reason });
  if (!parsed.success) {
    const reasonIssue = parsed.error.issues.find(issue => issue.path[0] === "reason");
    return { ok: false, error: reasonIssue?.message ?? `Select between 1 and ${MAX_GROUP_DECISION} roles.` };
  }
  try {
    const rows = await db().transaction(tx => recordDecisions(tx, user.id, parsed.data.jobIds, decision, parsed.data.reason.trim()));
    revalidateDecided();
    return { ok: true, decisionIds: Object.fromEntries(rows.map(row => [row.jobId, row.id])) };
  } catch (error) {
    const failure = actionError(error, "Could not save your decisions. Please try again.");
    return failure.ok ? { ok: false, error: "Could not save your decisions. Please try again." } : failure;
  }
}

/** All selected decisions must still be standing; one stale token reverses none of them. */
export async function undoDecisionsIfCurrent(expected: Array<{ jobId: string; decisionId: string }>): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = z.array(z.object({ jobId: zUuid(), decisionId: zUuid() })).min(1).max(MAX_GROUP_DECISION).safeParse(expected);
  if (!parsed.success || new Set(parsed.data.map(item => item.jobId)).size !== parsed.data.length)
    return fail(`Select between 1 and ${MAX_GROUP_DECISION} different decided roles.`);
  const ids = parsed.data.map(item => item.jobId).sort();
  const wanted = new Map(parsed.data.map(item => [item.jobId, item.decisionId]));
  try {
    await db().transaction(async tx => {
      await lockAccountScoreInput(tx as unknown as ReturnType<typeof db>, user.id, "exclusive");
      // Every decision writer takes these same account-role locks. Sort before taking any lock to
      // match recordDecisions and keep concurrent bulk operations deadlock-free.
      for (const id of ids) if (!await lockRoleView(tx, user.id, id)) throw new UserFacingError("A selected role no longer exists.");
      const standing = await tx.select({ jobId: decisions.jobId, id: decisions.id }).from(decisions)
        .where(and(eq(decisions.userId, user.id), inArray(decisions.jobId, ids), eq(decisions.superseded, false)));
      const current = new Map(standing.map(row => [row.jobId, row.id]));
      if (ids.some(id => current.get(id) !== wanted.get(id)))
        throw new UserFacingError("A selected decision changed in another tab. Reload roles before trying again.");
      await recordDecisions(tx, user.id, ids, null, "");
    });
  } catch (error) { return actionError(error, "Could not undo the selected decisions. Please try again."); }
  revalidateDecided();
  return ok();
}
