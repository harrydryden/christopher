import { XMLParser } from "fast-xml-parser";
import type { Adapter, FetchContext, RawPosting, SourceSpec } from "../types";
import { SourceFetchError } from "../types";
import { parseDate } from "../normalize";
import { asArray, htmlToText, joinLocation, safeUrl, slugOk, str, verifyFromFetch, MAX_POSTINGS } from "./common";

export function personioSpec(slug: string, host = `${slug}.jobs.personio.de`): SourceSpec {
  return { type: "personio", url: `https://${host}`, apiUrl: `https://${host}/xml`, atsSlug: slug, atsSite: host };
}

function fromUrl(url: string): SourceSpec | null {
  const u = safeUrl(url);
  if (!u) return null;
  const m = u.hostname.toLowerCase().match(/^([a-z0-9][a-z0-9-]*)\.jobs\.personio\.(de|com)$/);
  if (!m || !slugOk(m[1])) return null;
  return personioSpec(m[1]!, u.hostname.toLowerCase());
}

interface PersonioPosition {
  id?: string | number;
  subcompany?: string;
  office?: string;
  department?: string;
  recruitingCategory?: string;
  name?: string;
  jobDescriptions?: { jobDescription?: Array<{ name?: string; value?: string }> };
  employmentType?: string;
  seniority?: string;
  schedule?: string;
  occupation?: string;
  createdAt?: string;
}

const parser = new XMLParser({
  ignoreAttributes: true,
  trimValues: true,
  isArray: (name) => name === "position" || name === "jobDescription",
});

function mapPosition(p: PersonioPosition, host: string): RawPosting | null {
  const title = str(p.name);
  const id = str(p.id);
  if (!title || !id) return null;
  const descriptions = asArray(p.jobDescriptions?.jobDescription)
    .map((d) => {
      const heading = str(d?.name);
      const body = htmlToText(d?.value);
      return body ? (heading ? `${heading}\n${body}` : body) : undefined;
    })
    .filter(Boolean);
  return {
    externalId: id,
    title,
    url: `https://${host}/job/${id}`,
    location: joinLocation(p.office, p.subcompany),
    department: str(p.department) ?? str(p.recruitingCategory),
    employmentType: str(p.employmentType) ?? str(p.schedule),
    postedAt: parseDate(p.createdAt),
    descriptionText: descriptions.length ? descriptions.join("\n\n") : undefined,
  };
}

async function fetchPostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  const host = spec.atsSite ?? `${spec.atsSlug}.jobs.personio.de`;
  const res = await ctx.fetchText(`https://${host}/xml`, { headers: { accept: "application/xml,text/xml" } });
  if (res.status >= 400) throw new SourceFetchError(`HTTP ${res.status} from personio`, res.status === 403 || res.status === 429 ? "blocked" : "http", res.status);
  let parsed: unknown;
  try {
    parsed = parser.parse(res.body);
  } catch {
    throw new SourceFetchError("invalid XML from personio", "parse", res.status);
  }
  const root = (parsed as { "workzag-jobs"?: { position?: PersonioPosition[] } })["workzag-jobs"];
  const positions = asArray(root?.position);
  return positions.map((p) => mapPosition(p, host)).filter((p): p is RawPosting => !!p).slice(0, MAX_POSTINGS);
}

export const personio: Adapter = {
  type: "personio",
  specFromUrl: fromUrl,
  fetchPostings,
  verify: (spec, ctx) => verifyFromFetch(() => fetchPostings(spec, ctx))(),
};
