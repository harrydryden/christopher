import { ensureHttpUrl, extractDomain } from "@ava/core";

/**
 * What the Discover tab's one box was given: a name to search the catalogue for, or a homepage.
 * A homepage is one token with a dot and a plausible top-level domain, with or without a scheme and
 * a path; its registrable domain is what the catalogue is keyed on, so that is what is searched and
 * what "Add <domain>" names. Anything else is a name.
 */
export function domainFromQuery(raw: string): string | null {
  const query = raw.trim();
  if (!query || query.length > 200 || /\s/.test(query)) return null;
  if (!/^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i.test(query)) return null;
  try {
    return extractDomain(ensureHttpUrl(query));
  } catch {
    return null;
  }
}
