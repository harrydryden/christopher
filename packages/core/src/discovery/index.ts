/**
 * CONTRACT for careers-source discovery. Implemented in ./discover.ts and helpers.
 */
export type {
  DiscoveryContext,
  DiscoveryCandidate,
  DiscoveryResult,
  DiscoveryOutcome,
  DiscoveryAiHooks,
  HarvestedLink,
} from "./types";
export { discoverCareersSources, probeUrlAsSource } from "./discover";
export { harvestLinks, scoreLink, CAREERS_VOCABULARY, WELL_KNOWN_PATHS } from "./links";
export { confidenceFor, outcomeFor, AUTO_ACCEPT_CONFIDENCE, CONFIRM_CONFIDENCE } from "./confidence";
