/** A retained draft can contain wording while its build waits for a person's answer. */
export type CvPageStatus = "queued" | "generating" | "awaiting_evidence" | "awaiting_priorities" | "ready" | "failed";

export function cvPageMode(status: CvPageStatus, hasContent: boolean) {
  const processing = status === "queued" || status === "generating";
  const paused = status === "awaiting_evidence" || status === "awaiting_priorities";
  return { processing, paused, editable: hasContent && (status === "ready" || status === "failed") };
}
