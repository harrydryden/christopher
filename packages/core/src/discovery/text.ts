/** Small text utilities for discovery. No dependencies. */

const COMPANY_NOISE = /\b(inc|incorporated|ltd|limited|llc|l\.l\.c|plc|gmbh|ag|bv|b\.v|nv|sa|s\.a|ab|oy|as|co|corp|corporation|company|group|holdings|technologies|technology|labs|the)\b/gi;

export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(COMPANY_NOISE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** Sørensen–Dice coefficient over character bigrams. 1 = identical. */
export function diceCoefficient(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const aBig = bigrams(a);
  const bBig = bigrams(b);
  const counts = new Map<string, number>();
  for (const g of aBig) counts.set(g, (counts.get(g) ?? 0) + 1);
  let hits = 0;
  for (const g of bBig) {
    const n = counts.get(g) ?? 0;
    if (n > 0) {
      counts.set(g, n - 1);
      hits++;
    }
  }
  return (2 * hits) / (aBig.length + bBig.length);
}

/** Do these two company names plausibly refer to the same company? */
export function companyNamesMatch(a: string | undefined, b: string | undefined, threshold = 0.5): boolean {
  if (!a || !b) return true; // no evidence either way
  const x = normalizeCompanyName(a);
  const y = normalizeCompanyName(b);
  if (!x || !y) return true;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  return diceCoefficient(x, y) >= threshold;
}

const GENERIC_TITLES = new Set(["home", "homepage", "welcome", "index", "main", "start", "site", "official site", "official website"]);

/** Pull a company name out of a page title, dropping taglines and separators. */
export function companyNameFromTitle(title: string | undefined, fallbackDomain: string): string {
  const raw = (title ?? "").replace(/\s+/g, " ").trim();
  if (raw) {
    const segments = raw
      .split(/\s+[|–—·•]\s+|\s+-\s+|:\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2 && !GENERIC_TITLES.has(s.toLowerCase()));
    if (segments.length > 0) {
      const best = segments.reduce((a, b) => (b.length < a.length ? b : a));
      if (best.length <= 60) return best;
      return best.slice(0, 60).trim();
    }
  }
  const label = fallbackDomain.split(".")[0] ?? fallbackDomain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

const SOFT_404_RE = /(page not found|404 not found|couldn'?t find (?:that|this) page|page (?:doesn'?t|does not) exist|no longer available|nothing here)/i;

export function looksLikeSoft404(html: string): boolean {
  const head = html.slice(0, 4000);
  const title = head.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i)?.[1] ?? "";
  if (SOFT_404_RE.test(title)) return true;
  return SOFT_404_RE.test(head.replace(/<[^>]+>/g, " "));
}
