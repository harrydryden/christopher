import type { RawPosting } from "../types";
import { absoluteUrl, parseDate } from "../normalize";
import { asArray, htmlToText, joinLocation, rec, str } from "./common";

const SCRIPT_RE = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function typeOf(node: Record<string, unknown>): string[] {
  const t = node["@type"];
  return asArray(t).map((v) => str(v) ?? "").filter(Boolean);
}

/** Walk arrays, @graph, ItemList and mainEntity to find every JobPosting node. */
function collectJobPostings(node: unknown, out: Record<string, unknown>[], depth = 0): void {
  if (depth > 6 || node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const n of node) collectJobPostings(n, out, depth + 1);
    return;
  }
  const obj = rec(node);
  if (!obj) return;
  if (typeOf(obj).includes("JobPosting")) {
    out.push(obj);
    return;
  }
  for (const key of ["@graph", "itemListElement", "mainEntity", "mainEntityOfPage", "item", "hasPart"]) {
    if (key in obj) collectJobPostings(obj[key], out, depth + 1);
  }
}

function addressText(node: unknown): string | undefined {
  const obj = rec(node);
  if (!obj) return str(node);
  const addr = rec(obj.address) ?? obj;
  const country = str(addr.addressCountry) ?? str(rec(addr.addressCountry)?.name);
  return joinLocation(addr.addressLocality, addr.addressRegion, country) ?? str(obj.name);
}

function salaryText(node: unknown): string | undefined {
  const base = rec(node);
  if (!base) return undefined;
  const currency = str(base.currency) ?? str(base.salaryCurrency);
  const value = rec(base.value) ?? base;
  const min = str(value.minValue);
  const max = str(value.maxValue);
  const single = str(value.value);
  const unit = str(value.unitText);
  const amount = single ?? (min && max ? `${min} - ${max}` : (min ?? max));
  if (!amount) return undefined;
  return [currency, amount, unit ? `per ${unit.toLowerCase()}` : undefined].filter(Boolean).join(" ");
}

export function extractJsonLdPostings(html: string, pageUrl: string): RawPosting[] {
  const nodes: Record<string, unknown>[] = [];
  for (const m of html.matchAll(SCRIPT_RE)) {
    const body = (m[1] ?? "").trim();
    if (!body) continue;
    try {
      collectJobPostings(JSON.parse(body), nodes);
    } catch {
      // Some sites emit several concatenated JSON documents or trailing commas; try a lenient split.
      for (const chunk of body.split(/}\s*{/)) {
        const candidate = chunk.startsWith("{") ? chunk : `{${chunk}`;
        const closed = candidate.endsWith("}") ? candidate : `${candidate}}`;
        try {
          collectJobPostings(JSON.parse(closed), nodes);
        } catch {
          /* ignore */
        }
      }
    }
  }

  const out: RawPosting[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const title = str(node.title) ?? str(node.name);
    const identifier = rec(node.identifier);
    const rawUrl = str(node.url) ?? str(asArray(node.sameAs)[0]) ?? str(identifier?.url) ?? str(rec(node.mainEntityOfPage)?.["@id"]);
    if (!title || !rawUrl) continue;
    const url = absoluteUrl(rawUrl, pageUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const locations = asArray(node.jobLocation).map(addressText).filter((s): s is string => !!s);
    const employmentType = asArray(node.employmentType).map((v) => str(v)).filter(Boolean).join(", ") || undefined;
    out.push({
      externalId: str(identifier?.value) ?? str(node.identifier),
      title,
      url,
      location: locations[0],
      locations: locations.length > 1 ? locations : undefined,
      department: str(rec(node.hiringOrganization)?.department) ?? str(node.occupationalCategory),
      employmentType,
      remote: str(node.jobLocationType)?.toUpperCase() === "TELECOMMUTE" ? true : undefined,
      postedAt: parseDate(node.datePosted),
      descriptionText: htmlToText(node.description),
      salaryText: salaryText(node.baseSalary),
    });
  }
  return out;
}
