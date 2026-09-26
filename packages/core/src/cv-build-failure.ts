/**
 * What stopped a CV build, in the taxonomy the page and the queue both read.
 *
 * This is the whole of the decision: which kind a thrown error is, the sentence the person reads
 * for it, and the rule by which two kinds change hands once the system has already tried again.
 * It lives in core, with a test per kind, because it used to live inside the worker's handler
 * where the only way to exercise it was to drain a real queue against a real database — so the
 * sentences the product says were never checked, and a new failure kind could be added without
 * anyone reading what it would tell the person.
 *
 * Nothing here reads English out of an error message: the sentences that matter come from a
 * provider that is free to reword them. Everything is recognised by the class it was thrown as.
 */
import {
  cvBuildFailure,
  type CvBuildFailure,
  type CvFailureKind,
} from "./cv-build";
import { CvFitFailure } from "./cv-fit";
import { CvLayoutError } from "./cv-pdf";

/**
 * A failure that already knows what it is.
 *
 * Everything the build can be stopped by is either thrown as one of these, at the point that knows
 * which motion it was and what the model said, or is a class the classifier recognises.
 */
export class CvBuildStop extends Error {
  constructor(
    readonly kind: CvFailureKind,
    message: string,
    readonly extra: Partial<CvBuildFailure> = {},
  ) {
    super(message);
    this.name = "CvBuildStop";
  }
}

/**
 * The mark an error carries when this process has lost its place: the task was reclaimed, the
 * resource lease went, or the build's own fence refused a write.
 *
 * It is a property rather than a class so that core can name the failure without importing the
 * worker's lease, and so that a lease error crossing a module boundary is still recognised.
 */
export interface InterruptedError {
  readonly interrupted: true;
}

export function isInterruptedError(error: unknown): error is Error & InterruptedError {
  return typeof error === "object" && error !== null && (error as { interrupted?: unknown }).interrupted === true;
}

/** What a call was doing, in the two grammars the failure sentences need. */
export interface CvCallDoing {
  gerund: string;
  step: string;
}
export const RUBRIC_CALL: CvCallDoing = { gerund: "extracting the role's requirements", step: "requirements" };
export const AUTHOR_CALL: CvCallDoing = { gerund: "writing the CV", step: "writing" };
export const REVIEW_CALL: CvCallDoing = { gerund: "checking the CV against your evidence", step: "assessment" };

/**
 * One plain sentence for a model call that did not produce a usable answer, with the figures that
 * matter. The kind is what the system acts on; this is what the person reads.
 */
export function callFailureMessage(kind: CvFailureKind, doing: CvCallDoing, status?: number, note?: string): string {
  const where = ` while ${doing.gerund}`;
  switch (kind) {
    case "rate_limited":
      return `The model provider asked us to slow down${where}.`;
    case "overloaded":
      return `The model provider was overloaded${where}${status ? ` (HTTP ${status})` : ""}.`;
    case "connection":
      return `The connection to the model provider dropped${where}.`;
    case "stalled":
      return `The model stopped responding${where}: nothing arrived for fifteen minutes.`;
    case "model_access":
      return `The CV model could not be reached${where}${status ? ` (HTTP ${status})` : ""}. Check model access and usage in Health, then retry.`;
    case "output_limit":
      return `The model ran out of room for its answer${where}${note ? ` ${note}` : ""}.`;
    case "refused":
      return `The model declined to answer${where}${note ? ` ${note}` : ""}.`;
    default:
      return `The model's answer to the ${doing.step} step could not be used${note ? ` ${note}` : ""}.`;
  }
}

/** Asked of the person once the system has tried again and met the same thing. */
export const OUTPUT_LIMIT_ASK =
  "The model ran out of room for its answer twice. Choose a more capable CV model in Settings, then rebuild this CV.";
export const REFUSED_ASK =
  "The model declined this request twice. Check the job description for anything it may have objected to, then rebuild this CV.";

/** A build that ends without its place is a build whose writes would be stale; nothing else is wrong. */
export const CV_LOST_PLACE_MESSAGE = "This build lost its place to another worker before it finished.";

/** The page limit in the reader's terms: the figures, then the two things that would change it. */
export function cvPageLimitMessage(pages: number, maxPages: number): string {
  return `The CV is ${pages} ${pages === 1 ? "page" : "pages"} after three attempts; the limit is ${maxPages}. Remove some evidence in your Library or raise the page limit in Settings.`;
}

/**
 * A page limit that could be met only by removing the only evidence for an essential requirement.
 * It is the person's to resolve like any page limit: shorter Library wording or a higher limit.
 */
export function cvEssentialPageLimitMessage(pages: number, maxPages: number): string {
  return `The CV is ${pages} ${pages === 1 ? "page" : "pages"} after three attempts; the limit is ${maxPages}, and shortening it further would remove the only evidence for an essential requirement. Shorten that evidence in your Library or raise the page limit in Settings.`;
}

/**
 * What stopped the build, by the class it was thrown as.
 *
 * Everything that carries its own kind is taken at its word: a `CvBuildStop` raised where the
 * failure happened, and the fitter, which now names its failures in this taxonomy and carries the
 * policy for the one case where three attempts inside one build have already been spent. An
 * over-long layout is the page limit; an interrupted worker is recognised by its mark. Anything
 * else is honestly `unknown`, which asks the person rather than burning retries on something
 * nobody has understood yet.
 */
export function classifyCvBuildFailure(error: unknown): { kind: CvFailureKind; message: string; extra: Partial<CvBuildFailure> } {
  if (error instanceof CvBuildStop) return { kind: error.kind, message: error.message, extra: error.extra };
  if (error instanceof CvFitFailure) {
    if (error.kind === "page_limit_unfittable")
      return {
        kind: error.kind,
        message: (error.detail.essential ? cvEssentialPageLimitMessage : cvPageLimitMessage)(error.detail.pages ?? 0, error.detail.maxPages ?? 0),
        extra: { ...error.policy },
      };
    return { kind: error.kind, message: error.message, extra: { ...error.policy } };
  }
  if (error instanceof CvLayoutError) return { kind: "page_limit_unfittable", message: error.message, extra: {} };
  if (isInterruptedError(error)) return { kind: "worker_interrupted", message: CV_LOST_PLACE_MESSAGE, extra: {} };
  const detail = error instanceof Error && !error.message.startsWith("Failed query:")
    ? error.message : "Could not complete this CV. Please retry.";
  return { kind: "unknown", message: detail, extra: {} };
}

/**
 * The record this attempt leaves on the draft: what stopped it, whose move it is, and the figures
 * the page needs to say "attempt 2 of 3".
 *
 * Two failures change hands with repetition rather than being one thing always. A model that ran
 * out of room, or declined, is worth one more attempt by the system — the second time it is the
 * person who has to choose a different model or reword the role, because a third attempt would
 * meet the same model with the same prompt and cost the same money. The kind stays what it was,
 * so Operations still counts them together.
 */
export function cvBuildFailureFor(
  error: unknown,
  attempts: { attempt: number; maxAttempts: number; motion?: CvBuildFailure["motion"]; batch?: number },
): CvBuildFailure {
  const base = classifyCvBuildFailure(error);
  let message = base.message;
  const { motion, batch, ...counts } = attempts;
  // Where it happened: what the failure says for itself first (a batch knows its number, a refused
  // admission its motion), then the motion the build had open when it stopped.
  const where = {
    ...(base.extra.motion ?? motion ? { motion: base.extra.motion ?? motion } : {}),
    ...(base.extra.batch ?? batch ? { batch: base.extra.batch ?? batch } : {}),
  };
  let extra: Partial<CvBuildFailure> = { ...base.extra, ...counts, ...where };
  if (base.kind === "output_limit" || base.kind === "refused") {
    const ask = attempts.attempt >= 2;
    extra = ask
      ? { ...extra, resolvedBy: "user", retryable: false, action: base.kind === "output_limit" ? "choose_model" : "retry" }
      : { ...extra, resolvedBy: "system", retryable: true };
    if (ask) message = base.kind === "output_limit" ? OUTPUT_LIMIT_ASK : REFUSED_ASK;
  }
  // Operations reads the raw reason; the person never does. Kept whenever the sentence we show is
  // not the sentence that was thrown, such as a page limit reported in the reader's terms.
  if (!extra.cause && error instanceof Error && error.message !== message)
    extra = { ...extra, cause: error.message.slice(0, 500) };
  return cvBuildFailure(base.kind, message, extra);
}
