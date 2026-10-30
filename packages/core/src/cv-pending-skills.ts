import { createHash } from "node:crypto";
import { z } from "zod";
import { CV_LIMITS, cvSkillIdentity } from "./cv-format";
import { isActiveStoredEvidence, type CvContent, type CvLibrary, type CvPlan } from "./cv";

export const CvPendingSkillProposalSchema = z.object({
  id: z.string().uuid(),
  label: z.string().trim().min(1).max(CV_LIMITS.skillCharacters)
    .refine(value => !/[\r\n]/.test(value), "Each skill must be a single line."),
  category: z.string().trim().min(1).max(250).refine(value => !/[\r\n]/.test(value), "Keep the category on one line."),
  origin: z.enum(["model", "user"]),
  originEntryId: z.string().min(1).max(100).optional(),
  status: z.enum(["pending", "rejected", "accepted"]),
  decisionRequestKey: z.string().uuid().optional(),
  decisionHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  acceptedDraftId: z.string().uuid().optional(),
});
export const CvPendingSkillProposalsSchema = z.array(CvPendingSkillProposalSchema).max(250);
export type CvPendingSkillProposal = z.infer<typeof CvPendingSkillProposalSchema>;

/** Stable per revision/label: interrupted author calls cannot create duplicate opportunities. */
export function cvPendingSkillId(origin: "model" | "user", entryId: string, label: string): string {
  const hex = createHash("sha256").update(`${origin}\0${entryId}\0${cvSkillIdentity(label)}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Strip only model-suggested labels unsupported by the structured skill source. */
export function separateCvModelSkillProposals(library: CvLibrary, plan: CvPlan): {
  plan: CvPlan; proposals: CvPendingSkillProposal[];
} {
  const proposals: CvPendingSkillProposal[] = [];
  const sections = plan.sections.flatMap(section => {
    const source = library.entries.find(entry => entry.id === section.entryId);
    if (!source || source.kind !== "skill" || !source.skillItems || !section.skillItems) return [section];
    const known = section.skillItems.flatMap(label => {
      const exact = source.skillItems!.find(item => cvSkillIdentity(item) === cvSkillIdentity(label));
      return exact ? [exact] : [];
    });
    for (const label of section.skillItems.filter(item => !source.skillItems!.some(held => cvSkillIdentity(held) === cvSkillIdentity(item)))) {
      const parsed = CvPendingSkillProposalSchema.safeParse({ id: cvPendingSkillId("model", source.id, label),
        label, category: source.heading, origin: "model", originEntryId: source.id, status: "pending" });
      if (parsed.success && !proposals.some(item => item.id === parsed.data.id)) proposals.push(parsed.data);
    }
    if (!known.length) return [];
    return [{ ...section, skillItems: known, bullets: known.slice(0, section.bullets.length) }];
  });
  return { plan: { ...plan, sections }, proposals };
}

/** Manual labels remain visible on the member's draft, but are not asserted as Library facts. */
export function cvUserSkillProposals(library: CvLibrary, content: CvContent): CvPendingSkillProposal[] {
  const proposals: CvPendingSkillProposal[] = [];
  for (const section of content.sections) {
    if (section.kind !== "skill") continue;
    const labels = section.skillItems ?? section.bullets;
    for (const label of labels) {
      const held = library.entries.some(entry => entry.kind === "skill" && isActiveStoredEvidence(entry)
        && entry.skillItems?.some(item => cvSkillIdentity(item) === cvSkillIdentity(label)));
      if (held) continue;
      const parsed = CvPendingSkillProposalSchema.safeParse({ id: cvPendingSkillId("user", section.entryId, label),
        label, category: section.heading, origin: "user", originEntryId: section.entryId, status: "pending" });
      if (parsed.success && !proposals.some(item => item.id === parsed.data.id)) proposals.push(parsed.data);
    }
  }
  return proposals;
}
