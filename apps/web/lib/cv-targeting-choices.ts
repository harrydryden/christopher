import type { CvPriorityChoice, CvTargetingChoices, CvTargetingView } from "@col/core/cv-targeting";

export function cvTargetingEvidenceEntryIds(refs: readonly { sourceId: string }[]): string[] {
  return [...new Set(refs.flatMap(ref => {
    const match = /^entry:(.+?)(?::(?:row|skill):\d+)?$/.exec(ref.sourceId);
    return match ? [match[1]!] : [];
  }))];
}

/** Any omitted entry removes the broad profile from the writer's eligible evidence. */
export function cvTargetingHasProfileEvidence(refs: readonly { sourceId: string }[]): boolean {
  return refs.some(ref => ref.sourceId === "source:profile");
}

export function initialCvTargetingChoices(view: CvTargetingView): CvTargetingChoices {
  const requirements = [...view.priorities].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    .map(item => ({ id: item.id, text: item.text ?? item.label,
      essential: item.essential ?? item.importance === "essential" }));
  return { entries: view.entries.map(item => ({ entryId: item.entryId, treatment: item.treatment })),
    presentation: view.presentation,
    requirements,
    emphasisRequirementIds: requirements.slice(0, 5).map(item => item.id),
    acknowledgedEssentialOmissionIds: view.acknowledgedEssentialOmissionIds };
}

/** A rank edit moves one stable row; position in this array is the only stored rank. */
export function moveCvTargetingRequirement(rows: readonly CvPriorityChoice[], id: string, rank: number): CvPriorityChoice[] {
  const from = rows.findIndex(row => row.id === id);
  if (from < 0 || !Number.isInteger(rank) || rank < 1 || rank > rows.length) return [...rows];
  const next = [...rows];
  const [row] = next.splice(from, 1);
  next.splice(rank - 1, 0, row!);
  return next;
}

/** The first five ranked rows focus the writer; every row remains in review. */
export function withCvTargetingRequirements(choices: CvTargetingChoices, requirements: CvPriorityChoice[]): CvTargetingChoices {
  return { ...choices, requirements, emphasisRequirementIds: requirements.slice(0, 5).map(row => row.id) };
}

export function affectedCvTargetingEssentials(view: CvTargetingView, choices: CvTargetingChoices) {
  const omitted = new Set(choices.entries.filter(item => item.treatment === "omit").map(item => item.entryId));
  const chosen = new Map(choices.requirements?.map(item => [item.id, item]) ?? []);
  return view.priorities.filter(item => (chosen.get(item.id)?.essential ?? (item.importance === "essential")) &&
    (!choices.requirements || chosen.has(item.id)) &&
    (!choices.requirements || chosen.get(item.id)?.text.trim() === item.text.trim()) &&
    (item.evidenceEntryIds.length > 0 || item.hasProfileEvidence) &&
    item.evidenceEntryIds.every(id => omitted.has(id)) &&
    (!item.hasProfileEvidence || omitted.size > 0));
}

export function cvTargetingChoiceIssue(view: CvTargetingView, choices: CvTargetingChoices): string | null {
  if (choices.requirements) {
    const rows = choices.requirements;
    if (rows.length < 1) return "Keep at least one role requirement.";
    if (rows.length > 30) return "Keep no more than 30 role requirements.";
    if (new Set(rows.map(row => row.id)).size !== rows.length) return "Each role requirement needs a distinct identity.";
    if (rows.some(row => !row.text.trim() || row.text.trim().length > 250))
      return "Write each role requirement in 1–250 characters.";
    if (choices.emphasisRequirementIds.join("\u0000") !== rows.slice(0, 5).map(row => row.id).join("\u0000"))
      return "Reload the ranked requirements before confirming.";
  } else {
    const required = Math.min(3, view.priorities.length);
    if (choices.emphasisRequirementIds.length < required || choices.emphasisRequirementIds.length > Math.min(5, view.priorities.length))
      return "Choose three to five role priorities, or all available when there are fewer than three.";
  }
  if (affectedCvTargetingEssentials(view, choices).some(item => !choices.acknowledgedEssentialOmissionIds.includes(item.id)))
    return "Acknowledge each essential requirement that omitted evidence may affect.";
  return null;
}

export function normaliseCvTargetingChoices(view: CvTargetingView, choices: CvTargetingChoices): CvTargetingChoices {
  const affected = new Set(affectedCvTargetingEssentials(view, choices).map(item => item.id));
  return { ...choices, acknowledgedEssentialOmissionIds: choices.acknowledgedEssentialOmissionIds.filter(id => affected.has(id)) };
}
