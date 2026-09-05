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
} from "./registry";
export { extractJsonLdPostings } from "./jsonld";
export { extractPostingsFromHtml, applyRecipe, validateRecipe, findJobLinks } from "./html";
