"use server";

import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { CvContentSchema, CvLibrarySchema, isActiveStoredEvidence } from "@col/core/cv";
import { CV_LIMITS, CV_SKILL_GUIDANCE, cvSkillIdentity } from "@col/core/cv-format";
import { CvPendingSkillProposalsSchema, cvUserSkillProposals } from "@col/core/cv-pending-skills";
import { CvTargetingBriefSchema } from "@col/core/cv-targeting";
import { cvTargetingSource } from "@col/core/cv-targeting-identity";
import { cvReviewSkillSectionLimitIssue } from "@/lib/cv-review-edits";
import { cvDrafts, cvLibraries, lockCvDraft, nextCvRevision } from "@col/db";
import { requireVerifiedUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { latestLibrary, writeCvLibraryVersion } from "@/lib/cv-library-write";
import { cvRevisionRubricCheckpoint } from "@/lib/cv-rubric-carry";
import { UserFacingError, actionError, zUuid } from "@/lib/validation";
import { revalidatePath } from "next/cache";

const Decision = z.object({
  decision: z.enum(["accept", "reject"]),
  evidence: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("link_existing"), evidenceEntryId: z.string().min(1).max(180) }),
    z.object({ kind: z.literal("new_confirmed_row"), destinationEntryId: z.string().min(1).max(100),
      factualExample: z.string().trim().min(12).max(1000) }),
  ]).optional(),
  confirmFactual: z.literal(true).optional(),
  expectedRevision: z.number().int().nonnegative(),
  requestKey: z.string().uuid(),
}).superRefine((value, ctx) => {
  if (value.decision === "accept" && (!value.evidence || !value.confirmFactual))
    ctx.addIssue({ code: "custom", message: "Confirm how this skill is supported by your Experience." });
});
export type CvPendingSkillDecisionInput = z.input<typeof Decision>;
export type CvPendingSkillDecisionResult = { ok: true; destination: string } | { ok: false; error: string };

/** A decision is bound to its entire factual payload, not merely the browser request key. */
const decisionHash = (value: z.output<typeof Decision>) => createHash("sha256")
  .update(JSON.stringify({ decision: value.decision, evidence: value.evidence ?? null,
    confirmFactual: value.confirmFactual ?? false, expectedRevision: value.expectedRevision })).digest("hex");

export async function decideCvPendingSkill(draftId: string, proposalId: string,
  raw: CvPendingSkillDecisionInput): Promise<CvPendingSkillDecisionResult> {
  const user = await requireVerifiedUser();
  const parsed = Decision.safeParse(raw);
  if (!zUuid().safeParse(draftId).success || !zUuid().safeParse(proposalId).success || !parsed.success)
    return { ok: false, error: "Choose a saved skill opportunity and confirm its factual source." };
  const input = parsed.data;
  let destination = `/cv/${draftId}`;
  try {
    destination = await db().transaction(async tx => {
      await lockCvDraft(tx, draftId);
      const [draft] = await tx.select().from(cvDrafts)
        .where(and(eq(cvDrafts.id, draftId), eq(cvDrafts.userId, user.id))).limit(1).for("update");
      if (!draft?.content || !["ready", "failed"].includes(draft.status))
        throw new UserFacingError("This saved CV is no longer available. Reload it.");
      if (draft.revision !== input.expectedRevision)
        throw new UserFacingError("This CV changed. Reload its skill opportunities before deciding.");
      const snapshot = CvLibrarySchema.parse(draft.librarySnapshot);
      const content = CvContentSchema.parse(draft.content);
      const stored = CvPendingSkillProposalsSchema.parse(draft.pendingSkillProposals ?? []);
      const proposal = [...stored, ...cvUserSkillProposals(snapshot, content)]
        .find(item => item.id === proposalId);
      if (!proposal) throw new UserFacingError("This skill opportunity is no longer available. Reload the CV.");
      const hash = decisionHash(input);
      if (proposal.status !== "pending") {
        if (proposal.decisionRequestKey !== input.requestKey || proposal.decisionHash !== hash)
          throw new UserFacingError("This skill was already decided differently. Open the saved CV or reload.");
        return proposal.acceptedDraftId ? `/cv/${proposal.acceptedDraftId}` : `/cv/${draftId}`;
      }
      const latest = await latestLibrary(tx, user.id);
      if (!latest || latest.version !== draft.libraryVersion)
        throw new UserFacingError("Your Experience changed. Reload this CV before confirming a skill.");
      const current = CvLibrarySchema.parse(latest.content);
      const brief = draft.targetingBrief ? CvTargetingBriefSchema.parse(draft.targetingBrief) : null;
      const excluded = new Set(brief?.entries.filter(row => row.treatment === "omit").map(row => row.entryId) ?? []);
      const mark = (status: "accepted" | "rejected", acceptedDraftId?: string) => {
        const update = { ...proposal, status, decisionRequestKey: input.requestKey, decisionHash: hash,
          ...(acceptedDraftId ? { acceptedDraftId } : {}) };
        return CvPendingSkillProposalsSchema.parse([...stored.filter(item => item.id !== proposalId), update]);
      };
      if (input.decision === "reject") {
        await tx.update(cvDrafts).set({ pendingSkillProposals: mark("rejected") }).where(eq(cvDrafts.id, draftId));
        return `/cv/${draftId}`;
      }
      const evidence = input.evidence!;
      if (evidence.kind === "link_existing") {
        // Imported entry IDs can contain colons; the final numeric row suffix is the delimiter.
        const match = /^entry:(.+):row:(\d+)$/.exec(evidence.evidenceEntryId);
        const entry = current.entries.find(item => item.id === match?.[1] && item.kind === "experience"
          && isActiveStoredEvidence(item) && !excluded.has(item.id));
        if (!entry || !entry.confirmedResponsibilities?.[Number(match?.[2])])
          throw new UserFacingError("Choose a current confirmed Experience example that this CV includes.");
      } else {
        const entry = current.entries.find(item => item.id === evidence.destinationEntryId && item.kind === "experience"
          && isActiveStoredEvidence(item) && !excluded.has(item.id));
        if (!entry || (entry.confirmedResponsibilities?.length ?? 0) >= 20)
          throw new UserFacingError("Choose a current Experience role with room for a confirmed example.");
      }
      let updatedLibrary = current;
      const newVersion = await writeCvLibraryVersion(tx, user.id, draft.libraryVersion, currentLibrary => {
        if (!currentLibrary) throw new UserFacingError("Your Experience could not be found.");
        const entries = structuredClone(currentLibrary.entries);
        if (evidence.kind === "new_confirmed_row") {
          const entry = entries.find(item => item.id === evidence.destinationEntryId && item.kind === "experience")!;
          const example = evidence.factualExample;
          if ((entry.details.length + example.length + 1) > 40_000)
            throw new UserFacingError("Shorten the Experience example or its existing details before saving.");
          entry.details = `${entry.details}\n${example}`;
          entry.confirmedResponsibilities = [...(entry.confirmedResponsibilities ?? []), example];
        }
        let skill = entries.find(item => item.kind === "skill" && isActiveStoredEvidence(item)
          && cvSkillIdentity(item.heading) === cvSkillIdentity(proposal.category) && item.skillItems);
        if (!skill) {
          if (entries.length >= 100) throw new UserFacingError("Experience has reached its section limit. Remove a section before adding a skill.");
          const preferredId = proposal.origin === "user" && !entries.some(item => item.id === proposal.originEntryId)
            ? proposal.originEntryId : undefined;
          skill = { id: preferredId ?? `pending-skill-${randomUUID()}`, kind: "skill", heading: proposal.category,
            details: proposal.label, skillItems: [proposal.label] };
          entries.push(skill);
        } else if (!skill.skillItems!.some(item => cvSkillIdentity(item) === cvSkillIdentity(proposal.label))) {
          if (skill.skillItems!.length >= CV_SKILL_GUIDANCE.libraryPerSection)
            throw new UserFacingError("This Experience skill category is full. Remove a skill before accepting another.");
          skill.skillItems!.push(proposal.label);
        }
        updatedLibrary = CvLibrarySchema.parse({ ...currentLibrary, entries });
        return updatedLibrary;
      });
      const newSnapshot = CvLibrarySchema.parse({ ...updatedLibrary,
        theme: snapshot.theme, stylePreferences: snapshot.stylePreferences, preferredWording: snapshot.preferredWording });
      const skillEntry = newSnapshot.entries.find(item => item.kind === "skill" && isActiveStoredEvidence(item)
        && cvSkillIdentity(item.heading) === cvSkillIdentity(proposal.category) && item.skillItems?.some(label => cvSkillIdentity(label) === cvSkillIdentity(proposal.label)))!;
      if (excluded.has(skillEntry.id))
        throw new UserFacingError("This skill category is omitted from this CV. Feature it before accepting a skill into it.");
      const sections = structuredClone(content.sections);
      let section = sections.find(item => item.kind === "skill" && item.entryId === skillEntry.id);
      if (!section && proposal.origin === "user") section = sections.find(item => item.kind === "skill" && item.entryId === proposal.originEntryId);
      if (section) {
        section.entryId = skillEntry.id;
        if (!(section.skillItems ?? section.bullets).some(item => cvSkillIdentity(item) === cvSkillIdentity(proposal.label))) {
          const items = [...(section.skillItems ?? section.bullets), proposal.label];
          if (items.length > CV_LIMITS.skillsPerSection) throw new UserFacingError("This CV skill category is full. Remove a skill before accepting another.");
          section.skillItems = items; section.bullets = items.slice(0, CV_LIMITS.bulletsPerSection);
        }
      } else {
        if (sections.length >= CV_LIMITS.sections) throw new UserFacingError("This CV has reached its section limit.");
        sections.push({ entryId: skillEntry.id, kind: "skill", heading: skillEntry.heading,
          bullets: [proposal.label], skillItems: [proposal.label] });
      }
      const newContent = CvContentSchema.parse({ ...content, sections });
      const skillSectionIssue = cvReviewSkillSectionLimitIssue(newContent.sections, content.sections);
      if (skillSectionIssue) throw new UserFacingError(skillSectionIssue);
      const nextBrief = brief ? CvTargetingBriefSchema.parse({ ...brief,
        source: cvTargetingSource(newVersion, newSnapshot, draft.jobDescription),
        priority: { state: "unprepared", emphasisRequirementIds: brief.priority.emphasisRequirementIds,
          acknowledgedEssentialOmissionIds: [] } }) : null;
      const revision = await nextCvRevision(tx, draft, { spare: draftId });
      const { id: _id, createdAt: _created, assessment: _assessment, finalisedAt: _finalised,
        buildStage: _stage, progressAt: _progress, buildCheckpoint: _checkpoint, failure: _failure,
        ...original } = draft;
      const [child] = await tx.insert(cvDrafts).values({ ...original, userId: user.id, parentId: draftId,
        libraryVersion: newVersion, librarySnapshot: newSnapshot, content: newContent, status: "ready",
        revision, assessment: null, reviewDecision: null, finalisedAt: null, archivedAt: null,
        buildStage: null, buildCheckpoint: cvRevisionRubricCheckpoint(draft, draft.jobDescription), failure: null, semanticAuditCache: null,
        targetingBrief: nextBrief, pendingSkillProposals: mark("accepted") }).returning({ id: cvDrafts.id });
      await tx.update(cvDrafts).set({ pendingSkillProposals: mark("accepted", child!.id) }).where(eq(cvDrafts.id, draftId));
      return `/cv/${child!.id}`;
    });
  } catch (error) {
    const result = actionError(error, "Could not save this skill decision. Reload the CV and try again.");
    return { ok: false, error: result.ok ? "Could not save this skill decision." : result.error };
  }
  revalidatePath(`/cv/${draftId}`);
  revalidatePath("/library");
  return { ok: true, destination };
}
