import type { HandlerMap } from "../queue";
import { handleDiscover } from "./discover";
import { handleRunDaily } from "./daily";
import { handleScanCompany } from "./scan";
import { handleFetchDescription } from "./description";
import { handleProfileCompany, handleSuggestCompanies } from "./companies";
import {
  handleReevaluateGate,
  handleRescoreAll,
  handleScoreJob,
  handleSuggestFilters,
  handleSynthesizeProfile,
  handleTagReason,
} from "./learning";

export const handlers: HandlerMap = {
  discover: handleDiscover,
  run_daily: handleRunDaily,
  scan_company: handleScanCompany,
  fetch_description: handleFetchDescription,
  score_job: handleScoreJob,
  tag_reason: handleTagReason,
  synthesize_profile: handleSynthesizeProfile,
  suggest_filters: handleSuggestFilters,
  profile_company: handleProfileCompany,
  suggest_companies: handleSuggestCompanies,
  rescore_all: handleRescoreAll,
  reevaluate_gate: handleReevaluateGate,
};

export { handleDiscover, handleRunDaily, handleScanCompany, handleFetchDescription };
