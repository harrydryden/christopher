/**
 * The icon URLs the browser tries for a company, in order: what the worker stored, the site's
 * own `/favicon.ico`, then a public icon service keyed by domain. Bot-protected sites refuse the
 * worker but let a browser in, so the chain runs client-side and each miss steps to the next.
 */
export function iconCandidates(src: string | null | undefined, domain: string | null | undefined): string[] {
  const out: string[] = [];
  const push = (url: string | null | undefined) => { if (url && !out.includes(url)) out.push(url); };
  push(src);
  const host = (domain ?? "").trim().toLowerCase().replace(/^www\./, "");
  if (host && /^[a-z0-9.-]+$/.test(host)) {
    push(`https://${host}/favicon.ico`);
    push(`https://icons.duckduckgo.com/ip3/${host}.ico`);
  }
  return out;
}
