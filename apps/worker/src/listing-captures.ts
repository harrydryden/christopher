import { gunzipSync } from "node:zlib";
import { SourceFetchError, type RenderedPage } from "@col/core";

export const MAX_DECODED_LISTING_BYTES = 5_000_000;

/** A decoded capture is held only for the current iteration. Browser captures take precedence. */
export function* listingCaptures(rendered: RenderedPage, maxDecodedBytes = MAX_DECODED_LISTING_BYTES): Generator<{ html: string; url: string }> {
  if (rendered.compressedListingPages?.length) {
    for (const capture of rendered.compressedListingPages) {
      if (!Number.isInteger(capture.decodedBytes) || capture.decodedBytes < 0 || capture.decodedBytes > maxDecodedBytes)
        throw new SourceFetchError("Browser listing capture exceeds its decoded byte limit", "parse");
      let decoded: Buffer;
      try { decoded = gunzipSync(capture.gzip, { maxOutputLength: maxDecodedBytes }); }
      catch { throw new SourceFetchError("Browser listing capture is corrupt or exceeds its decoded byte limit", "parse"); }
      if (decoded.byteLength !== capture.decodedBytes)
        throw new SourceFetchError("Browser listing capture decoded length does not match its metadata", "parse");
      yield { html: decoded.toString("utf8"), url: capture.url };
    }
    if (rendered.finalCaptureUnstored) {
      if (Buffer.byteLength(rendered.html, "utf8") > maxDecodedBytes)
        throw new SourceFetchError("Browser final listing capture exceeds its decoded byte limit", "parse");
      yield { html: rendered.html, url: rendered.finalUrl };
    }
    return;
  }
  if (rendered.listingPages?.length) {
    yield* rendered.listingPages;
    return;
  }
  yield { html: rendered.html, url: rendered.finalUrl };
}

export function listingCaptureCount(rendered: RenderedPage): number {
  if (rendered.compressedListingPages?.length) return rendered.compressedListingPages.length + (rendered.finalCaptureUnstored ? 1 : 0);
  return rendered.listingPages?.length || 1;
}
