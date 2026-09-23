import { ats } from "@ava/core";

type KnownSource = { type: string; url: string; apiUrl: string | null; atsSlug: string | null; atsSite: string | null; status: string };

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

const within = (host: string, base: string) => host === base || host.endsWith(`.${base}`);

/**
 * Whether a pasted posting URL is on one of the company's own hosts: its website (or a subdomain),
 * the host of a careers page it is scanned from, or its own board on an ATS. A board host such as
 * boards.greenhouse.io is shared by every company on that vendor, so there the board itself — the
 * vendor and slug a source of this company names — has to match, not just the host.
 *
 * A posting that is not is still the pasting account's (R-5.3: a role you went and found is one you
 * meant to see), but it is theirs alone: it is not offered to the company's other followers, whose
 * tables would otherwise carry a link anyone could have planted.
 */
export function postingOnCompanyHost(url: string, company: { domain: string; homepageUrl: string }, sources: KnownSource[]): boolean {
  const host = hostOf(url);
  if (!host) return false;
  const live = sources.filter(source => source.status !== "disabled");
  if (ats.isAtsHost(host)) {
    const spec = ats.specFromAnyUrl(url);
    if (!spec?.atsSlug) return false;
    return live.some(source => source.type === spec.type && source.atsSlug?.toLowerCase() === spec.atsSlug!.toLowerCase()
      && (source.atsSite ?? null) === (spec.atsSite ?? null));
  }
  // The homepage's own host is the base. The registrable domain is only used when the homepage is
  // on it, because it collapses a site like acme.github.io to github.io, which anyone can publish on.
  const home = hostOf(company.homepageUrl);
  if (home && within(host, home)) return true;
  if (home === company.domain && within(host, company.domain)) return true;
  return live.some(source => source.type === "html" && [source.url, source.apiUrl].some(own => own && hostOf(own) === host));
}
