/** One next step above the CV workspace, derived from the draft rather than a separate status. */
export function cvNextAction(input: {
  status: "queued" | "generating" | "awaiting_evidence" | "ready" | "failed";
  finalised: boolean;
  hasFinalPdf?: boolean;
  hasContent: boolean;
  assessmentCurrent: boolean;
  factualConcerns: number;
  finaliseReason: string | null;
  improving: boolean;
  libraryChanged: boolean;
}): { title: string; detail: string; target: "content" | "evaluation" | "review" | "download"; action: string } {
  if (input.status === "queued" || input.status === "generating")
    return { title: "Building your CV", detail: "When it finishes, check the wording and evidence in Review.", target: "content", action: "View build progress" };
  if (input.status === "awaiting_evidence")
    return { title: "Answer or skip the evidence questions", detail: "Confirm any new facts for Experience, or skip the questions to continue this build.", target: "content", action: "Open evidence questions" };
  if (input.status === "failed")
    return { title: "Resolve the build failure", detail: "Read the failure, then retry or rewrite from Experience.", target: "content", action: "Review failure" };
  if (input.finalised)
    return input.hasFinalPdf
      ? { title: "Download your final CV", detail: "The PDF you finalised is ready. Create a new revision if you want to change or reassess it.", target: "download", action: "Download PDF" }
      : { title: "Create a new revision", detail: "This finalised CV has no saved PDF available. Save a new revision, review it and finalise it to get a downloadable document.", target: "content", action: "Open CV wording" };
  if (!input.hasContent || !input.assessmentCurrent)
    return { title: "Check this CV", detail: "Check this saved revision before finalising.", target: "evaluation", action: "Open Review" };
  if (input.factualConcerns > 0)
    return { title: "Review the flagged items", detail: `${input.factualConcerns} factual ${input.factualConcerns === 1 ? "concern needs" : "concerns need"} a decision. You can edit, add evidence, mark nothing further to add, or explicitly finalise anyway.`, target: "review", action: "Review flagged items" };
  if (input.finaliseReason)
    return { title: "Finish the remaining check", detail: input.finaliseReason, target: "evaluation", action: "Open Review" };
  if (input.improving)
    return { title: "Review the ready CV", detail: "A stronger revision is being checked in the background. You can review this CV now; any adopted revision will appear as a new version.", target: "evaluation", action: "Open Review" };
  return {
    title: "Review and finalise this CV",
    detail: input.libraryChanged
      ? "Review this CV. Your Experience has changed; rewrite from it if newer facts should appear, or finalise this saved revision after checking it."
      : "Review the wording and evidence gaps, then finalise this CV.",
    target: "evaluation",
    action: "Open Review",
  };
}
