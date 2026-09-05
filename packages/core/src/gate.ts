/**
 * Keyword and location gate. Decides which stored postings appear in the main table.
 * Pure functions; see docs/SPEC.md section 3.5.
 */
import { looksRemote } from "./normalize";

export type MatchField = "title" | "department" | "description";

export interface GateSettings {
  includeKeywords: string[];
  excludeKeywords: string[];
  matchFields: MatchField[];
  /** Location terms the user cares about, e.g. ["London", "UK"]. Empty means every location passes. */
  locationTerms: string[];
  /** Whether remote roles pass the location filter when their text does not name a conflicting region. */
  includeRemote: boolean;
}

export const DEFAULT_GATE_SETTINGS: GateSettings = {
  includeKeywords: ["operations"],
  excludeKeywords: [],
  matchFields: ["title"],
  locationTerms: [],
  includeRemote: true,
};

export interface GateInput {
  title: string;
  department?: string | null;
  description?: string | null;
  location?: string | null;
  locations?: string[] | null;
  remote?: boolean | null;
}

export interface GateResult {
  keywordMatched: boolean;
  keywordTerms: string[];
  excluded: boolean;
  excludedTerms: string[];
  locationOk: boolean;
  locationTerms: string[];
  remote: boolean;
  inTable: boolean;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a user term into a word-boundary regex.
 *  - `operations`            -> whole word, case-insensitive
 *  - `operat*`               -> prefix match
 *  - `"chief of staff"`      -> exact phrase, flexible whitespace
 *  - `ops`                   -> whole word (does not match "develops")
 */
export function compileTerm(term: string): RegExp | null {
  let t = term.trim();
  if (!t) return null;
  const quoted = /^".*"$/.test(t) || /^'.*'$/.test(t);
  if (quoted) t = t.slice(1, -1).trim();
  const prefix = !quoted && t.endsWith("*");
  if (prefix) t = t.slice(0, -1);
  if (!t) return null;
  const parts = t.split(/\s+/).map(escapeRegex);
  const body = parts.join("\\s+");
  const lead = /^[\p{L}\p{N}]/u.test(t) ? "(?<![\\p{L}\\p{N}])" : "";
  const trail = prefix ? "[\\p{L}\\p{N}]*" : /[\p{L}\p{N}]$/u.test(t) ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(`${lead}${body}${trail}`, "iu");
}

function matchTerms(text: string, terms: string[]): string[] {
  const hits: string[] = [];
  for (const term of terms) {
    const re = compileTerm(term);
    if (re && re.test(text)) hits.push(term);
  }
  return hits;
}

/**
 * Location aliases. A user term expands to its group; "uk" also matches "London" etc.
 * Country and region names here also serve as the "names another region" detector for remote roles.
 */
const ALIAS_GROUPS: Record<string, string[]> = {
  uk: ["uk", "u.k.", "united kingdom", "great britain", "britain", "england", "scotland", "wales", "northern ireland",
    "london", "manchester", "birmingham", "edinburgh", "glasgow", "bristol", "leeds", "cambridge", "oxford", "reading",
    "belfast", "cardiff", "liverpool", "sheffield", "nottingham", "newcastle", "brighton", "milton keynes"],
  ireland: ["ireland", "dublin", "cork", "galway"],
  usa: ["usa", "u.s.", "u.s.a.", "us", "united states", "united states of america", "america"],
  canada: ["canada", "toronto", "vancouver", "montreal", "ottawa", "calgary"],
  germany: ["germany", "deutschland", "berlin", "munich", "münchen", "hamburg", "frankfurt", "cologne", "köln"],
  france: ["france", "paris", "lyon", "marseille"],
  netherlands: ["netherlands", "the netherlands", "holland", "amsterdam", "rotterdam", "utrecht", "eindhoven"],
  spain: ["spain", "madrid", "barcelona", "valencia"],
  portugal: ["portugal", "lisbon", "porto"],
  italy: ["italy", "milan", "rome", "turin"],
  switzerland: ["switzerland", "zurich", "zürich", "geneva", "basel", "lausanne"],
  sweden: ["sweden", "stockholm", "gothenburg"],
  denmark: ["denmark", "copenhagen"],
  norway: ["norway", "oslo"],
  finland: ["finland", "helsinki"],
  poland: ["poland", "warsaw", "krakow", "kraków", "wroclaw", "wrocław", "gdansk"],
  austria: ["austria", "vienna", "wien"],
  belgium: ["belgium", "brussels", "antwerp", "ghent"],
  israel: ["israel", "tel aviv", "jerusalem", "haifa"],
  india: ["india", "bangalore", "bengaluru", "mumbai", "delhi", "new delhi", "hyderabad", "pune", "chennai", "gurgaon", "gurugram", "noida"],
  singapore: ["singapore"],
  australia: ["australia", "sydney", "melbourne", "brisbane", "perth"],
  "new zealand": ["new zealand", "auckland", "wellington"],
  japan: ["japan", "tokyo", "osaka"],
  uae: ["uae", "united arab emirates", "dubai", "abu dhabi"],
  brazil: ["brazil", "brasil", "são paulo", "sao paulo", "rio de janeiro"],
  mexico: ["mexico", "méxico", "mexico city", "guadalajara", "monterrey"],
  europe: ["europe", "eu", "european union", "emea"],
  apac: ["apac", "asia pacific", "asia-pacific"],
  latam: ["latam", "latin america"],
  "north america": ["north america", "americas"],
  remote: ["remote", "anywhere", "work from home", "wfh", "distributed", "telecommute"],
};

/** US states and major cities, used only to detect "names another region" for remote roles. */
const US_PLACES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida", "georgia",
  "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland",
  "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire",
  "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania",
  "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont", "virginia", "washington",
  "west virginia", "wisconsin", "wyoming", "washington, dc", "washington dc", "d.c.",
  "san francisco", "los angeles", "san diego", "seattle", "austin", "boston", "chicago", "denver", "atlanta", "miami",
  "dallas", "houston", "phoenix", "philadelphia", "costa mesa", "irvine", "orange county", "huntington beach",
  "palo alto", "mountain view", "menlo park", "sunnyvale", "san jose", "oakland", "redmond", "bellevue", "reston",
  "arlington", "boulder", "raleigh", "nashville", "pittsburgh", "detroit", "minneapolis", "salt lake city", "las vegas",
  "portland", "sacramento", "orlando", "tampa", "charlotte", "columbus", "cincinnati", "indianapolis", "kansas city",
  "st. louis", "milwaukee", "baltimore", "new orleans", "honolulu", "anchorage", "el segundo", "lexington park",
];

const allAliases: Array<{ group: string; alias: string; re: RegExp }> = [];
for (const [group, aliases] of Object.entries(ALIAS_GROUPS)) {
  for (const alias of aliases) {
    const re = compileTerm(`"${alias}"`);
    if (re) allAliases.push({ group, alias, re });
  }
}
for (const place of US_PLACES) {
  const re = compileTerm(`"${place}"`);
  if (re) allAliases.push({ group: "usa", alias: place, re });
}

/** Expand a user location term to the alias group it belongs to (or itself). */
export function expandLocationTerm(term: string): { group: string | null; patterns: RegExp[] } {
  const key = term.trim().toLowerCase().replace(/^"|"$/g, "");
  for (const [group, aliases] of Object.entries(ALIAS_GROUPS)) {
    if (group === key || aliases.includes(key)) {
      // A city term (e.g. "London") should not expand to the whole country; only group heads and country names expand.
      const isGroupHead = group === key || COUNTRY_NAMES.has(key);
      const list = isGroupHead ? aliases : [key];
      return { group, patterns: list.map((a) => compileTerm(`"${a}"`)).filter((r): r is RegExp => !!r) };
    }
  }
  const re = compileTerm(term);
  return { group: null, patterns: re ? [re] : [] };
}

const COUNTRY_NAMES = new Set([
  "uk", "u.k.", "united kingdom", "great britain", "britain", "ireland", "usa", "u.s.", "u.s.a.", "us", "united states",
  "united states of america", "america", "canada", "germany", "deutschland", "france", "netherlands", "the netherlands",
  "holland", "spain", "portugal", "italy", "switzerland", "sweden", "denmark", "norway", "finland", "poland", "austria",
  "belgium", "israel", "india", "singapore", "australia", "new zealand", "japan", "uae", "united arab emirates", "brazil",
  "brasil", "mexico", "méxico", "europe", "eu", "european union", "emea", "apac", "asia pacific", "asia-pacific", "latam",
  "latin america", "north america", "americas",
]);

export function locationTexts(input: GateInput): string[] {
  const out = new Set<string>();
  if (input.location) out.add(input.location);
  for (const l of input.locations ?? []) if (l) out.add(l);
  return [...out];
}

/** Which alias groups does a location string mention? */
export function regionsMentioned(text: string): Set<string> {
  const groups = new Set<string>();
  for (const a of allAliases) if (a.re.test(text)) groups.add(a.group);
  return groups;
}

export function evaluateLocation(input: GateInput, settings: Pick<GateSettings, "locationTerms" | "includeRemote">) {
  const texts = locationTexts(input);
  const joined = texts.join(" | ");
  const remote = input.remote === true || looksRemote(joined);
  const terms = settings.locationTerms.map((t) => t.trim()).filter(Boolean);
  if (terms.length === 0) return { ok: true, terms: [] as string[], remote };

  const hits: string[] = [];
  const wantedGroups = new Set<string>();
  for (const term of terms) {
    const { group, patterns } = expandLocationTerm(term);
    if (group) wantedGroups.add(group);
    if (patterns.some((re) => texts.some((t) => re.test(t)))) hits.push(term);
  }
  if (hits.length > 0) return { ok: true, terms: hits, remote };

  if (remote && settings.includeRemote) {
    // "Remote" with no region, or a region that is one of ours, passes. "Remote - USA" for a UK user fails.
    const mentioned = regionsMentioned(joined);
    mentioned.delete("remote");
    const conflicting = [...mentioned].filter((g) => !wantedGroups.has(g) && !isSuperRegionOf(g, wantedGroups));
    if (conflicting.length === 0) return { ok: true, terms: ["remote"], remote };
  }
  if (texts.length === 0 && settings.includeRemote && remote) return { ok: true, terms: ["remote"], remote };
  return { ok: false, terms: [], remote };
}

const SUPER_REGIONS: Record<string, string[]> = {
  europe: ["uk", "ireland", "germany", "france", "netherlands", "spain", "portugal", "italy", "switzerland", "sweden",
    "denmark", "norway", "finland", "poland", "austria", "belgium"],
  "north america": ["usa", "canada", "mexico"],
  apac: ["india", "singapore", "australia", "new zealand", "japan"],
  latam: ["brazil", "mexico"],
};

function isSuperRegionOf(group: string, wanted: Set<string>): boolean {
  const members = SUPER_REGIONS[group];
  if (!members) return false;
  return members.some((m) => wanted.has(m));
}

export function evaluateGate(input: GateInput, settings: GateSettings): GateResult {
  const fields = new Set(settings.matchFields.length ? settings.matchFields : ["title"]);
  const haystackParts: string[] = [input.title];
  if (fields.has("department") && input.department) haystackParts.push(input.department);
  if (fields.has("description") && input.description) haystackParts.push(input.description);
  const haystack = haystackParts.join("\n");

  const keywordTerms = matchTerms(haystack, settings.includeKeywords);
  const keywordMatched = settings.includeKeywords.filter((k) => k.trim()).length === 0 ? true : keywordTerms.length > 0;
  // Exclusions are checked against title and department regardless of matchFields, never against description alone.
  const excludeHaystack = [input.title, input.department ?? ""].join("\n");
  const excludedTerms = matchTerms(excludeHaystack, settings.excludeKeywords);
  const excluded = excludedTerms.length > 0;

  const loc = evaluateLocation(input, settings);
  return {
    keywordMatched,
    keywordTerms,
    excluded,
    excludedTerms,
    locationOk: loc.ok,
    locationTerms: loc.terms,
    remote: loc.remote,
    inTable: keywordMatched && !excluded && loc.ok,
  };
}

/** Parse a comma or newline separated user list into clean terms. Quoted phrases are preserved. */
export function parseTermList(raw: string): string[] {
  const out: string[] = [];
  const re = /"[^"]*"|'[^']*'|[^,\n;]+/g;
  for (const m of raw.matchAll(re)) {
    const t = m[0].trim();
    if (t) out.push(t);
  }
  return [...new Set(out)];
}
