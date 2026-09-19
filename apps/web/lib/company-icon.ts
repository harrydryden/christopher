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

/**
 * The interface's own URL for the logo the worker captured, versioned by capture time so a
 * re-capture invalidates a cached image while the URL stays immutable for a week. Null when
 * nothing has been captured for this company yet.
 */
export function companyLogoUrl(id: string, logoFetchedAt: Date | string | null | undefined): string | null {
  if (!logoFetchedAt) return null;
  const ms = logoFetchedAt instanceof Date ? logoFetchedAt.getTime() : Date.parse(logoFetchedAt);
  if (!Number.isFinite(ms)) return null;
  return `/api/companies/${id}/logo?v=${ms}`;
}

/**
 * What every company icon in the interface is fed: the stored capture when there is one, and the
 * remote favicon URL otherwise, so the browser chain above still covers the companies the worker
 * has not captured yet. One source of truth, so the roles table and the company page can no longer
 * disagree about what a company looks like.
 */
export function companyIcon(company: { id: string; faviconUrl: string | null; domain: string; logoFetchedAt: Date | string | null }): { src: string | null; domain: string } {
  return { src: companyLogoUrl(company.id, company.logoFetchedAt) ?? company.faviconUrl, domain: company.domain };
}
