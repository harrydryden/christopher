/**
 * Keyword and location gate. Decides which stored postings appear in the main table.
 * Pure functions; see docs/SPEC.md section 3.5.
 */
import { looksRemote } from "./normalize";

export type MatchField = "title" | "department" | "description";

export interface GateSettings {
  includeKeywords: string[];
  excludeKeywords: string[];
  /** Title-only seniority: OR within this list, AND with role keywords. */
  seniorityKeywords?: string[];
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
 *  - `operat*`               -> prefix: Operations, Operational, Operator
 *  - `*ops`                  -> suffix: DevOps, RevOps (still ends at a word boundary)
 *  - `strateg* lead`         -> a wildcard inside a phrase applies to that word
 *  - `"chief of staff"`      -> exact phrase, flexible whitespace, no wildcards
 *  - `ops`                   -> whole word (does not match "develops")
 * A bare `*` or a term that is only wildcards compiles to nothing rather than
 * matching everything.
 */
export function compileTerm(term: string): RegExp | null {
  // Terms repeat endlessly (every follower's gate, every posting), and the patterns carry no global
  // or sticky flag, so one compiled RegExp per term is safe to share. Bounded: oldest out first.
  if (TERM_CACHE.has(term)) return TERM_CACHE.get(term)!;
  const re = buildTerm(term);
  if (TERM_CACHE.size >= TERM_CACHE_LIMIT) TERM_CACHE.delete(TERM_CACHE.keys().next().value!);
  TERM_CACHE.set(term, re);
  return re;
}

const TERM_CACHE_LIMIT = 2_000;
const TERM_CACHE = new Map<string, RegExp | null>();

function buildTerm(term: string): RegExp | null {
  let t = term.trim();
  if (!t) return null;
  const quoted = /^".*"$/.test(t) || /^'.*'$/.test(t);
  if (quoted) t = t.slice(1, -1).trim();
  if (!t || /^[*\s]+$/.test(t)) return null;
  const words = t.split(/\s+/).filter(Boolean);
  const WORD = "[\\p{L}\\p{N}]";
  const body = words.map((word, index) => {
    if (quoted) return escapeRegex(word);
    // `*` at either end of a word widens that word; anywhere else it is literal.
    const prefix = word.endsWith("*") && word.length > 1;
    const suffix = word.startsWith("*") && word.length > 1;
    const core = word.slice(suffix ? 1 : 0, prefix ? -1 : undefined);
    if (!core) return null;
    const lead = index === 0 && !suffix && /^[\p{L}\p{N}]/u.test(core) ? `(?<!${WORD})` : suffix ? `${WORD}*` : "";
    const trail = index === words.length - 1 && !prefix && /[\p{L}\p{N}]$/u.test(core) ? `(?!${WORD})` : prefix ? `${WORD}*` : "";
    return `${lead}${escapeRegex(core)}${trail}`;
  });
  if (body.some((part) => part === null)) return null;
  if (quoted) {
    const lead = /^[\p{L}\p{N}]/u.test(t) ? `(?<!${WORD})` : "";
    const trail = /[\p{L}\p{N}]$/u.test(t) ? `(?!${WORD})` : "";
    return new RegExp(`${lead}${body.join("\\s+")}${trail}`, "iu");
  }
  return new RegExp(body.join("\\s+"), "iu");
}

interface CompiledTerm {
  term: string;
  re: RegExp | null;
}

function compileTerms(terms: string[]): CompiledTerm[] {
  return terms.map((term) => ({ term, re: compileTerm(term) }));
}

function matchTerms(text: string, terms: CompiledTerm[]): string[] {
  const hits: string[] = [];
  for (const { term, re } of terms) {
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

interface CompiledLocation {
  terms: Array<{ term: string; patterns: RegExp[] }>;
  wantedGroups: Set<string>;
  includeRemote: boolean;
}

function compileLocation(settings: Pick<GateSettings, "locationTerms" | "includeRemote">): CompiledLocation {
  const wantedGroups = new Set<string>();
  const terms = settings.locationTerms.map((t) => t.trim()).filter(Boolean).map((term) => {
    const { group, patterns } = expandLocationTerm(term);
    if (group) wantedGroups.add(group);
    return { term, patterns };
  });
  return { terms, wantedGroups, includeRemote: settings.includeRemote };
}

export function evaluateLocation(input: GateInput, settings: Pick<GateSettings, "locationTerms" | "includeRemote">) {
  return locate(input, compileLocation(settings));
}

function locate(input: GateInput, compiled: CompiledLocation) {
  const texts = locationTexts(input);
  const joined = texts.join(" | ");
  const remote = input.remote === true || looksRemote(joined);
  if (compiled.terms.length === 0) return { ok: true, terms: [] as string[], remote };

  const hits: string[] = [];
  const { wantedGroups } = compiled;
  for (const { term, patterns } of compiled.terms) {
    if (patterns.some((re) => texts.some((t) => re.test(t)))) hits.push(term);
  }
  if (hits.length > 0) return { ok: true, terms: hits, remote };

  if (remote && compiled.includeRemote) {
    // "Remote" with no region, or a region that is one of ours, passes. "Remote - USA" for a UK user fails.
    const mentioned = regionsMentioned(joined);
    mentioned.delete("remote");
    const conflicting = [...mentioned].filter((g) => !wantedGroups.has(g) && !isSuperRegionOf(g, wantedGroups));
    if (conflicting.length === 0) return { ok: true, terms: ["remote"], remote };
  }
  if (texts.length === 0 && compiled.includeRemote && remote) return { ok: true, terms: ["remote"], remote };
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

/** One gate with every pattern built once, for evaluating many postings against it. */
export interface CompiledGate {
  readonly settings: GateSettings;
  /** Whether the gate matches on the description, so a posting's text can change its verdict. */
  readonly matchesDescription: boolean;
  evaluate(input: GateInput): GateResult;
}

/**
 * Build every keyword, exclusion, seniority and location pattern of a gate once. `evaluateGate`
 * is this with a single use; a scan that judges a listing for its followers compiles each gate
 * once and evaluates every posting against the result, which gives the same verdicts without
 * rebuilding a country's worth of location patterns per posting.
 */
export function compileGate(settings: GateSettings): CompiledGate {
  const fields = new Set(settings.matchFields.length ? settings.matchFields : ["title"]);
  const include = compileTerms(settings.includeKeywords);
  const includeRequired = settings.includeKeywords.filter((k) => k.trim()).length > 0;
  const exclude = compileTerms(settings.excludeKeywords);
  const seniorityList = settings.seniorityKeywords ?? [];
  const seniority = compileTerms(seniorityList);
  const seniorityRequired = seniorityList.some((t) => t.trim());
  const location = compileLocation(settings);
  return {
    settings,
    matchesDescription: fields.has("description"),
    evaluate(input: GateInput): GateResult {
      const haystackParts: string[] = [input.title];
      if (fields.has("department") && input.department) haystackParts.push(input.department);
      if (fields.has("description") && input.description) haystackParts.push(input.description);
      const haystack = haystackParts.join("\n");

      const keywordTerms = matchTerms(haystack, include);
      const keywordMatched = includeRequired ? keywordTerms.length > 0 : true;
      // Exclusions are checked against title and department regardless of matchFields, never against description alone.
      const excludeHaystack = [input.title, input.department ?? ""].join("\n");
      const excludedTerms = matchTerms(excludeHaystack, exclude);
      const seniorityTerms = matchTerms(input.title, seniority);
      const seniorityOk = !seniorityRequired || seniorityTerms.length > 0;
      const excluded = excludedTerms.length > 0 || !seniorityOk;

      const loc = locate(input, location);
      return {
        keywordMatched,
        keywordTerms: [...keywordTerms, ...seniorityTerms.filter(t => !keywordTerms.includes(t))],
        excluded,
        excludedTerms,
        locationOk: loc.ok,
        locationTerms: loc.terms,
        remote: loc.remote,
        inTable: keywordMatched && !excluded && loc.ok,
      };
    },
  };
}

export function evaluateGate(input: GateInput, settings: GateSettings): GateResult {
  return compileGate(settings).evaluate(input);
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
