/**
 * Some sites never let an automated reader in: LinkedIn's robots.txt disallows our crawler on
 * every path, and other pages answer with a sign-in wall. A discovery source pointed at one of
 * those is not broken — it simply has to be fed by hand, exactly like an email newsletter. We
 * recognise that class of failure so the source is presented as import only instead of failing
 * a scheduled check every day forever.
 */
const IMPORT_ONLY_RE = /robots\.txt disallows|sign-in required|authwall|blocked \((?:401|403)\)/i;

export function isImportOnlySourceError(message: string | null | undefined): boolean {
  return !!message && IMPORT_ONLY_RE.test(message);
}

/**
 * Kinds that are fed by hand by definition. LinkedIn disallows automated reading on every path,
 * so a LinkedIn source is never fetched at all: each edition is pasted in. An email source has an
 * inbound endpoint, but nothing to fetch either.
 */
const IMPORT_ONLY_KINDS = new Set(["email", "linkedin"]);

export function isImportOnlyKind(kind: string): boolean {
  return IMPORT_ONLY_KINDS.has(kind);
}

/** True when nothing about this source can be collected automatically by fetching its URL. */
export function sourceIsImportOnly(input: { kind: string; lastError?: string | null }): boolean {
  return isImportOnlyKind(input.kind) || isImportOnlySourceError(input.lastError);
}

/** A plain sentence for the interface, given the source's URL and kind. */
export function importOnlyReason(url: string | null | undefined, kind?: string): string {
  let host = "";
  try { host = url ? new URL(url).hostname.replace(/^www\./, "") : ""; } catch { host = ""; }
  const site = kind === "linkedin" || /(^|\.)linkedin\.com$/.test(host) ? "LinkedIn" : host || "This site";
  return `${site} does not allow automated reading. Subscribe with the delivery address below, or paste each edition's text, and it is read on the next check.`;
}
