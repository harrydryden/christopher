import { sha1 } from "@col/core";

export const MAX_DESCRIPTION_RETRY_ATTEMPTS = 6;
/** Delays after attempts one through five; the sixth requires a person or changed advert. */
export const DESCRIPTION_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 60 * 60_000, 24 * 60 * 60_000, 3 * 24 * 60 * 60_000] as const;

export interface DescriptionRevisionInput {
  sourceId: string;
  sourceType: string;
  sourceUrl: string;
  sourceApiUrl?: string | null;
  sourceSlug?: string | null;
  sourceSite?: string | null;
  postingUrl: string;
  title: string;
  department?: string | null;
  vendorUpdatedAt?: Date | string | null;
}

/** Ordinary daily scans keep the same revision; changed listing evidence starts a fresh sequence. */
export function descriptionInputRevision(input: DescriptionRevisionInput): string {
  return sha1(JSON.stringify([input.sourceId, input.sourceType, input.sourceUrl, input.sourceApiUrl,
    input.sourceSlug, input.sourceSite, input.postingUrl, input.title, input.department, input.vendorUpdatedAt]));
}
