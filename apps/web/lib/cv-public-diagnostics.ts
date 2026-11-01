/** Viewer-specific copies of stored CV diagnostics. The stored rows stay intact for Operations. */
import { CV_BUILD_MOTIONS, type CvBuildFailure } from "@col/core";
import { cvBuildState, type CvBuildDraft, type CvBuildTask, type CvBuildState } from "./cv-build-state";
import type { CvJournalStep } from "./cv-build-journal";

const OPERATOR_KINDS = new Set<CvBuildFailure["kind"]>([
  "model_access", "provider_billing_exhausted", "request_invalid", "refused", "rate_limited",
  "overloaded", "connection", "stalled", "output_limit", "output_invalid",
  "assessment_incomplete", "worker_interrupted", "unknown",
]);
const SERVICE_MESSAGE = "CV generation is temporarily unavailable. Your saved work is retained. Ask an administrator to check the service before retrying.";
const STEP_MESSAGE = "This step could not be completed. Your saved work is retained.";

export function cvMemberFailureMessage(failure: CvBuildFailure | null): string {
  if (!failure) return "This build stopped before it finished. Your saved work is retained. Try again, or ask an administrator if it keeps happening.";
  switch (failure.kind) {
    case "budget_exhausted":
      if (failure.budgetLimit === "account")
        return "This CV needs more than your remaining monthly AI budget. Review your budget in Settings before retrying. No CV credit was used.";
      if (failure.budgetLimit === "day" || failure.budgetLimit === "discovery")
        return "The CV service is temporarily unavailable. Your saved work is retained. Ask an administrator when it can resume. No CV credit was used.";
      return "An AI spending limit stopped this CV. Review your budget in Settings or ask an administrator before retrying. No CV credit was used.";
    case "library_invalid":
      return "This CV could not use the saved Experience. Review the Library, then retry.";
    case "page_limit_unfittable":
      return "This CV could not fit its chosen page limit. Summarise or omit selected material, or raise this CV's limit.";
    case "description_unusable":
      return "The job description could not be used. Check the full advert, then try again.";
    default:
      return SERVICE_MESSAGE;
  }
}

export function cvViewerFailure(failure: CvBuildFailure | null | undefined, admin: boolean): CvBuildFailure | null {
  if (!failure) return null;
  if (admin) return failure;
  const { cause: _cause, ...rest } = failure;
  return { ...rest, message: cvMemberFailureMessage(failure) };
}

/** Construct the same state machine from member-safe input; no raw error enters rendered HTML. */
export function cvViewerBuildState(draft: CvBuildDraft, task: CvBuildTask | null, now: Date,
  timeZone: string, admin: boolean): CvBuildState {
  if (admin) return cvBuildState(draft, task, now, timeZone);
  const failure = cvViewerFailure(draft.failure, false);
  const legacyAccountBudget = !failure && /monthly AI budget/i.test(draft.error ?? "");
  const safeDraft = { ...draft, failure, error: legacyAccountBudget
    ? "Your monthly AI budget has been reached. Review it in Settings before retrying."
    : cvMemberFailureMessage(failure) };
  const safeTask = task ? { ...task, error: null } : null;
  const state = cvBuildState(safeDraft, safeTask, now, timeZone);
  const operatorFailure = failure && (OPERATOR_KINDS.has(failure.kind) ||
    (failure.kind === "budget_exhausted" && (failure.budgetLimit === "day" || failure.budgetLimit === "discovery")));
  return {
    ...state,
    title: operatorFailure ? "CV service unavailable" : state.title,
    message: operatorFailure && state.phase === "retrying"
      ? "A build attempt stopped. The service will retry automatically while attempts remain."
      : state.message,
    taskError: null,
    action: legacyAccountBudget && state.phase === "failed" ? "raise_budget" : state.action,
  };
}

const SAFE_DETAIL_TEXT: Record<string, ReadonlySet<string>> = {
  pass: new Set(["draft", "revision"]),
  mode: new Set(["assess"]),
  reused: new Set(["checkpoint", "parent", "previous"]),
  stage: new Set(["rubric", "author", "review", "improve"]),
};

/** A member's build log keeps counts and timing, never arbitrary provider or worker text. */
export function cvViewerStep(step: CvJournalStep, admin: boolean): CvJournalStep {
  if (admin) return step;
  const detail = Object.fromEntries(Object.entries(step.detail).filter(([key, value]) =>
    (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean" ||
    (typeof value === "string" && SAFE_DETAIL_TEXT[key]?.has(value)))) as Record<string, unknown>;
  const known = CV_BUILD_MOTIONS[step.motion as keyof typeof CV_BUILD_MOTIONS];
  const title = step.motion === "admit_budget" ? "Preparing the build" : known?.title ?? "Build activity";
  return { ...step, title, detail, error: step.status === "failed" ? STEP_MESSAGE : null,
    failure: null };
}

export function cvViewerSkillSuggestionError(error: string | null, admin: boolean): string | null {
  if (!error || admin) return error;
  if (/^(Your Experience|Experience or target role|This CV changed|This CV or Experience)/.test(error))
    return "Your CV or Experience changed. Generate skills again.";
  return "Skill suggestions could not be prepared just now. Try again later.";
}

/** Keep known document and public-site validation guidance; unknown stored failures are private. */
export function cvViewerLibraryImportError(error: string, admin: boolean): string {
  if (admin) return error;
  if (error === "There is no readable text in that PDF.") return error;
  if (error === "There was not enough text in that to read a career from. Paste more of it, or upload the document itself.") return error;
  if (error === "Course of Life could not make sense of that document. Try a different export of it, or paste the text instead.") return error;
  if (/^The page at [^\s]+ answered HTTP 4\d\d\. Check that the link opens without signing in\.$/.test(error))
    return "That page could not be opened without signing in. Check the link, or paste its text instead.";
  if (/^[^\s]+ points into a private network, so Course of Life will not fetch it\./.test(error))
    return "That address cannot be read safely. Use your own public page, or paste its text instead.";
  if (/^[^\s]+ asks not to be fetched automatically\. Paste the text of the page instead\.$/.test(error))
    return "That page cannot be read automatically. Paste its text instead.";
  return "This document could not be read just now. Try again, or paste its text instead.";
}
