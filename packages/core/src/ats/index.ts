/**
 * CONTRACT for the ATS adapter registry. Implemented in ./registry.ts and the per-ATS modules.
 * Consumers (discovery, worker) import only from this file.
 */
export type { Adapter, SourceSpec, RawPosting, VerifyResult, SourceType, FetchContext, HtmlRecipe } from "../types";
export {
  adapters,
  getAdapter,
  specFromAnyUrl,
  findAtsSpecsInText,
  isAtsHost,
  fetchDescriptionFor,
  descriptionsFetchedPerPosting,
  fetchHtmlPage,
} from "./registry";
export { extractJsonLdPostings } from "./jsonld";
export { MAX_POSTINGS } from "./common";
export { extractPostingsFromHtml, applyRecipe, validateRecipe, findJobLinks, compactDomForModel, nextListingPage, isExplicitEmptyListing } from "./html";
