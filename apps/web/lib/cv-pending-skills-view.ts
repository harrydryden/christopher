import { CvContentSchema, CvLibrarySchema, isActiveStoredEvidence } from "@col/core/cv";
import { cvSkillEvidenceRows } from "@col/core";
import { CvPendingSkillProposalsSchema, cvUserSkillProposals } from "@col/core/cv-pending-skills";
import { CvTargetingBriefSchema, projectCvWritingLibrary } from "@col/core/cv-targeting";
import { getOwnCvDraft } from "@/lib/queries/cv";

type OwnedDraft = NonNullable<Awaited<ReturnType<typeof getOwnCvDraft>>>;

/** Saved-revision opportunities; the member's manual labels stay visible until resolved. */
export async function getCvPendingSkillView(userId: string, draftId: string) {
  const draft = await getOwnCvDraft(userId, draftId);
  return draft ? cvPendingSkillViewForOwnedDraft(userId, draft) : null;
}

/** Derive the panel from a draft the page has already read and checked for this account. */
export function cvPendingSkillViewForOwnedDraft(userId: string, draft: OwnedDraft) {
  const draftId = draft.id;
  if (draft.userId !== userId || !draft.content || !["ready", "failed"].includes(draft.status)) return null;
  const library = CvLibrarySchema.parse(draft.librarySnapshot);
  const brief = draft.targetingBrief ? CvTargetingBriefSchema.parse(draft.targetingBrief) : null;
  const eligible = projectCvWritingLibrary(library, brief);
  const stored = CvPendingSkillProposalsSchema.parse(draft.pendingSkillProposals ?? []);
  const content = CvContentSchema.parse(draft.content);
  const proposals = [...stored];
  for (const proposal of cvUserSkillProposals(library, content))
    if (!proposals.some(item => item.id === proposal.id)) proposals.push(proposal);
  return { draftId, revision: draft.revision,
    proposals: proposals.filter(item => item.status === "pending"),
    eligibleEvidenceRows: cvSkillEvidenceRows(eligible),
    eligibleDestinations: eligible.entries.filter(entry => entry.kind === "experience" &&
      isActiveStoredEvidence(entry)).map(entry => ({
      entryId: entry.id, heading: entry.heading,
    })),
  };
}
export type CvPendingSkillView = NonNullable<Awaited<ReturnType<typeof getCvPendingSkillView>>>;
