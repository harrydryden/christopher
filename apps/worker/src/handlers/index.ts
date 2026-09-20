import { handleGenerateCv } from "./cv";
import { handleImportLibraryDocument } from "./library-import";
import { handleReviewLibrary } from "./library-review";
import type { HandlerMap } from "../queue";
import { handleDiscover } from "./discover";
import { handleRunDaily } from "./daily";
import { handleScanCompany } from "./scan";
import { handleFetchDescription } from "./description";
import { handleImportPosting } from "./import-posting";
import { handleProfileCompany, handleSuggestCompanies } from "./companies";
import {
  handleReevaluateGate,
  handleRescoreAll,
  handleScoreJob,
  handleSuggestFilters,
  handleSynthesizeProfile,
  handleTagReason,
} from "./learning";

import { handleMonitorSource, handleExtractDocument, handleVerifyCompany } from "./external-sources";
import { handleSuggestFromScans } from "./suggest-from-scans";

export const handlers: HandlerMap = {
  extract_document: handleExtractDocument,
  verify_company: handleVerifyCompany,
  monitor_source: handleMonitorSource,
  generate_cv: handleGenerateCv,
  discover: handleDiscover,
  run_daily: handleRunDaily,
  scan_company: handleScanCompany,
  fetch_description: handleFetchDescription,
  import_posting: handleImportPosting,
  score_job: handleScoreJob,
  tag_reason: handleTagReason,
  synthesize_profile: handleSynthesizeProfile,
  suggest_filters: handleSuggestFilters,
  suggest_from_scans: handleSuggestFromScans,
  profile_company: handleProfileCompany,
  suggest_companies: handleSuggestCompanies,
  rescore_all: handleRescoreAll,
  reevaluate_gate: handleReevaluateGate,
  review_library: handleReviewLibrary,
  import_library_document: handleImportLibraryDocument,
};

export { handleDiscover, handleRunDaily, handleScanCompany, handleFetchDescription, handleImportPosting };

// Kept in a module of its own so that importing "what to do when a task is abandoned" does not
// drag every handler in with it: the scheduler needs the hooks and nothing else here.
export { CV_ABANDONED_MESSAGE, onAbandon, onInterrupted } from "./abandon";
