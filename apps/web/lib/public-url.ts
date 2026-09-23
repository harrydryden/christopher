import { assertPublicHttpUrl, UnsafeUrlError } from "@ava/core";

/**
 * Why the worker will not fetch `url` — a private or local address, a scheme other than http(s),
 * credentials in it — as a sentence the person who typed it can read, or null when it may. The same
 * rule the worker enforces (`assertPublicHttpUrl`); asking here turns a task that would only fail
 * later into a refusal at the moment the address is entered.
 */
export function unsafeUrlRefusal(url: string): string | null {
  try {
    assertPublicHttpUrl(url);
    return null;
  } catch (error) {
    if (!(error instanceof UnsafeUrlError)) throw error;
    return /[.!?]$/.test(error.message) ? error.message : `${error.message}.`;
  }
}
