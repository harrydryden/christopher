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

/** A plain sentence for the interface, given the source's URL. */
export function importOnlyReason(url: string | null | undefined): string {
  let host = "";
  try { host = url ? new URL(url).hostname.replace(/^www\./, "") : ""; } catch { host = ""; }
  const site = /(^|\.)linkedin\.com$/.test(host) ? "LinkedIn" : host || "This site";
  return `${site} does not allow automated reading, so this source is import only. Paste each edition's text under Import text below.`;
}
