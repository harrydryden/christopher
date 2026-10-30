import type { CvTargetingChoices, CvTargetingView } from "@col/core/cv-targeting";

export function initialCvTargetingChoices(view: CvTargetingView): CvTargetingChoices {
  return { entries: view.entries.map(item => ({ entryId: item.entryId, treatment: item.treatment })),
    presentation: view.presentation,
    emphasisRequirementIds: view.priorities.filter(item => item.selected).map(item => item.id),
    acknowledgedEssentialOmissionIds: view.acknowledgedEssentialOmissionIds };
}

export function affectedCvTargetingEssentials(view: CvTargetingView, choices: CvTargetingChoices) {
  const omitted = new Set(choices.entries.filter(item => item.treatment === "omit").map(item => item.entryId));
  return view.priorities.filter(item => item.importance === "essential" &&
    item.evidenceEntryIds.length > 0 && item.evidenceEntryIds.every(id => omitted.has(id)));
}

export function cvTargetingChoiceIssue(view: CvTargetingView, choices: CvTargetingChoices): string | null {
  const required = Math.min(3, view.priorities.length);
  if (choices.emphasisRequirementIds.length < required || choices.emphasisRequirementIds.length > Math.min(5, view.priorities.length))
    return "Choose three to five role priorities, or all available when there are fewer than three.";
  if (affectedCvTargetingEssentials(view, choices).some(item => !choices.acknowledgedEssentialOmissionIds.includes(item.id)))
    return "Acknowledge each essential requirement that omitted evidence may affect.";
  return null;
}

export function normaliseCvTargetingChoices(view: CvTargetingView, choices: CvTargetingChoices): CvTargetingChoices {
  const affected = new Set(affectedCvTargetingEssentials(view, choices).map(item => item.id));
  return { ...choices, acknowledgedEssentialOmissionIds: choices.acknowledgedEssentialOmissionIds.filter(id => affected.has(id)) };
}
