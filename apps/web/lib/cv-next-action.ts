/** One next step above the CV workspace, derived from the draft rather than a separate status. */
export function cvNextAction(input: {
  status: "queued" | "generating" | "awaiting_evidence" | "ready" | "failed";
  finalised: boolean;
  hasContent: boolean;
  assessmentCurrent: boolean;
  factualConcerns: number;
  finaliseReason: string | null;
  improving: boolean;
  libraryChanged: boolean;
}): { title: string; detail: string; target: "content" | "evaluation" | "review" | "download"; action: string } {
  if (input.status === "queued" || input.status === "generating")
    return { title: "Building your CV", detail: "The build is in progress. When it finishes, review the wording and evidence in Evaluation.", target: "content", action: "View build progress" };
  if (input.status === "awaiting_evidence")
    return { title: "Answer or skip the evidence questions", detail: "Confirm any new facts for your Library, or skip the questions to continue this build.", target: "content", action: "Open evidence questions" };
  if (input.status === "failed")
    return { title: "Resolve the build failure", detail: "Read the failure, then use Retry generation or Rebuild from Library.", target: "content", action: "Review failure" };
  if (input.finalised)
    return { title: "Download your final CV", detail: "The saved PDF is ready. You can also create a preview link for comments in Content.", target: "download", action: "Download PDF" };
  if (!input.hasContent || !input.assessmentCurrent)
    return { title: "Fit and assess this revision", detail: "Check this revision before finalising.", target: "evaluation", action: "Open assessment" };
  if (input.factualConcerns > 0)
    return { title: "Review the flagged items", detail: `Evaluation found ${input.factualConcerns} factual ${input.factualConcerns === 1 ? "concern" : "concerns"}. Review each item, dismiss it if you have nothing further to add, or choose to finalise anyway.`, target: "review", action: "Review flagged items" };
  if (input.finaliseReason)
    return { title: "Finish the remaining check", detail: input.finaliseReason, target: "evaluation", action: "Open Evaluation" };
  if (input.improving)
    return { title: "Review the ready CV", detail: "A stronger revision is being checked in the background. You can review this CV now; any adopted revision will appear as a new version.", target: "evaluation", action: "Open Evaluation" };
  return {
    title: "Review and finalise this CV",
    detail: input.libraryChanged
      ? "Review the wording and evidence in Evaluation. Your Library has changed; rebuild from it if the newer facts should appear, or finalise this revision after checking it."
      : "Review the wording, score and evidence gaps in Evaluation, then select Finalise this CV.",
    target: "evaluation",
    action: "Open Evaluation",
  };
}
