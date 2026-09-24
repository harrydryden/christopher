/**
 * Recommend role-type keywords and seniority labels from what recent scans
 * actually listed. Pure: the worker feeds it the parsed postings kept in each
 * source's latest scan snapshot; nothing here touches a network or a model.
 *
 * The question it answers is the one the stored table cannot: of the roles in
 * the user's geography that the gate is *not* admitting, which words would
 * admit the most of them? Two kinds of answer:
 *
 *  - Seniority labels: titles that match the role keywords and the location
 *    but fail the seniority list. "Lead" admitting nine London roles is a
 *    recommendation; "Intern" admitting two is not, so labels come from a
 *    fixed vocabulary of seniority words, never from arbitrary title tokens.
 *  - Role-type terms: frequent title words among location-passing roles that
 *    the include list does not cover. Level words (manager, lead, analyst…)
 *    are never proposed as role types. When a word appears in several
 *    inflections (strategy / strategic) the wildcard form is proposed, since
 *    whole-word matching is exactly what made the user miss them.
 */
import { compileGate, compileTerm, evaluateLocation, type GateInput, type GateSettings } from "./gate";

export interface ScannedTitle extends GateInput {
  title: string;
  company: string;
}

export interface TermSuggestion {
  term: string;
  /** Roles in the user's geography this term would admit that nothing admits today. */
  admits: number;
  companies: number;
  examples: Array<{ title: string; company: string }>;
}

export interface ScanSuggestions {
  /** Location-passing postings that the gate does not admit — the pool being mined. */
  unmatched: number;
  seniority: TermSuggestion[];
  roleTypes: TermSuggestion[];
}

/** Seniority words worth proposing, most senior first. Matched with the gate's own term compiler. */
export const SENIORITY_VOCABULARY = [
  "Chief", "President", "Vice President", "VP", "SVP", "EVP", "Managing Director", "General Manager", "Director",
  "Associate Director", "Head", "Head of", "Principal", "Staff", "Lead", "Senior", "Manager", "Partner", "Founding",
];

/** Words that describe a level or a job noun, not a field of work. Never proposed as a role type. */
const LEVEL_WORDS = new Set([
  ...SENIORITY_VOCABULARY.map((w) => w.toLowerCase()), "of", "and", "the", "for", "in", "to", "a", "an", "at", "with", "on",
  "manager", "management", "lead", "leader", "leadership", "senior", "junior", "associate", "assistant", "analyst", "specialist",
  "coordinator", "executive", "officer", "intern", "internship", "graduate", "apprentice", "trainee", "head", "director",
  "consultant", "advisor", "adviser", "engineer", "engineering", "team", "role", "roles", "job", "jobs", "position", "positions",
  "us", "uk", "emea", "europe", "london", "remote", "hybrid", "global", "international", "regional", "new", "group", "ii", "iii", "iv",
  "i", "ii", "sr", "jr", "staff", "principal", "vp", "svp", "evp", "chief", "president", "partner", "founding", "general",
]);

function tokens(title: string): string[] {
  return title.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/[\s-]+/).filter((w) => w.length >= 3 && !LEVEL_WORDS.has(w) && !/^\d+$/.test(w));
}

function covered(term: string, existing: string[]): boolean {
  const re = compileTerm(term);
  if (!re) return true;
  // Already listed verbatim, or an existing wildcard/phrase already matches this word.
  return existing.some((e) => e.trim().toLowerCase() === term.toLowerCase() || (compileTerm(e)?.test(term) ?? false));
}

function collect(pool: ScannedTitle[], key: (t: ScannedTitle) => string[]): Map<string, ScannedTitle[]> {
  const map = new Map<string, ScannedTitle[]>();
  for (const posting of pool) for (const k of new Set(key(posting))) (map.get(k) ?? map.set(k, []).get(k)!).push(posting);
  return map;
}

function toSuggestion(term: string, matches: ScannedTitle[]): TermSuggestion {
  const seen = new Set<string>();
  const examples: TermSuggestion["examples"] = [];
  for (const m of matches) {
    const k = `${m.company}|${m.title}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (examples.length < 3) examples.push({ title: m.title, company: m.company });
  }
  return { term, admits: matches.length, companies: new Set(matches.map((m) => m.company)).size, examples };
}

/**
 * Group inflections that share a stem of at least five letters and propose the
 * wildcard when two or more distinct words share it: strategy + strategic ->
 * "strateg*". A single word is proposed as itself.
 *
 * A word can only join a group whose stem shares its first five letters, so the
 * groups are indexed by those five letters and a word is offered only the groups
 * in its own block — in the order the whole map holds them, which is the order a
 * scan of every group would have met them in. Linear in the words rather than in
 * words times groups.
 */
function wildcardGroups(words: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  const blocks = new Map<string, string[]>();
  const sorted = [...new Set(words)].sort();
  for (const word of sorted) {
    let placed = false;
    const block = word.length >= 5 ? blocks.get(word.slice(0, 5)) : undefined;
    for (const [at, stem] of (block ?? []).entries()) {
      const shared = commonPrefix(stem, word);
      if (shared.length >= 5 && shared.length >= Math.min(stem.length, word.length) - 3) {
        const members = groups.get(stem)!;
        // A stem another group already holds is overwritten where it stands, as a map does.
        const standing = shared !== stem && groups.has(shared);
        groups.delete(stem);
        groups.set(shared, [...members, word]);
        // Otherwise it moved to the end of the map, so to the end of its block too.
        block!.splice(at, 1);
        if (!standing) block!.push(shared);
        placed = true;
        break;
      }
    }
    if (!placed) {
      groups.set(word, [word]);
      if (word.length >= 5) (blocks.get(word.slice(0, 5)) ?? blocks.set(word.slice(0, 5), []).get(word.slice(0, 5))!).push(word);
    }
  }
  return groups;
}

/**
 * Every word of every title, read as the term compiler reads words (runs of letters and digits,
 * without case), with the positions of the titles it appears in. A term's matches are then a
 * lookup — the titles holding that word, or any word starting with a wildcard's stem — instead of
 * one regular expression run over every title per term.
 */
function wordIndex(pool: ScannedTitle[]): { find: (term: string) => number[] } {
  const index = new Map<string, number[]>();
  pool.forEach((posting, position) => {
    for (const word of new Set(posting.title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])) {
      (index.get(word) ?? index.set(word, []).get(word)!).push(position);
    }
  });
  const sorted = [...index.keys()].sort();
  const firstAtLeast = (key: string) => {
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (sorted[mid]! < key) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  return {
    find(term: string) {
      if (!term.endsWith("*")) return index.get(term) ?? [];
      const stem = term.slice(0, -1);
      const hits = new Set<number>();
      for (let at = firstAtLeast(stem); at < sorted.length && sorted[at]!.startsWith(stem); at++) for (const position of index.get(sorted[at]!)!) hits.add(position);
      return [...hits].sort((a, b) => a - b);
    },
  };
}

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

export function suggestFromScans(postings: ScannedTitle[], gate: GateSettings, opts: { minAdmits?: number; limit?: number } = {}): ScanSuggestions {
  const minAdmits = opts.minAdmits ?? 3;
  const limit = opts.limit ?? 8;
  // Each gate variant compiled once for the whole pool, rather than once per posting.
  const full = compileGate(gate);
  const withoutSeniority = compileGate({ ...gate, seniorityKeywords: [] });
  const withoutKeywords = compileGate({ ...gate, includeKeywords: [] });
  const inGeography = postings.filter((p) => evaluateLocation(p, gate).ok);
  const unmatched = inGeography.filter((p) => !full.evaluate(p).inTable);

  // Seniority: roles the keywords and location already accept, held back only by the level list.
  const heldBySeniority = unmatched.filter((p) => withoutSeniority.evaluate(p).inTable);
  const seniority = SENIORITY_VOCABULARY
    .filter((label) => !covered(label, gate.seniorityKeywords ?? []))
    .map((label) => {
      const re = compileTerm(label)!;
      return toSuggestion(label, heldBySeniority.filter((p) => re.test(p.title)));
    })
    .filter((s) => s.admits >= minAdmits)
    .sort((a, b) => b.admits - a.admits)
    .slice(0, limit);

  // Role types: frequent title words in the geography, seniority-passing when a
  // seniority list exists, that no include term covers and no exclude term hits.
  // With no include terms the gate reduces to location, exclusions and
  // seniority — exactly the pool a new role term would have to admit from.
  const candidates = unmatched.filter((p) => withoutKeywords.evaluate(p).inTable);
  const byWord = collect(candidates, (p) => tokens(p.title));
  const words = wordIndex(candidates);
  // Group every word first: a single "partnership" beside two "partnerships" is
  // what makes the wildcard worth proposing, so the count threshold applies to
  // the group, never the word.
  const groups = wildcardGroups([...byWord.keys()]);
  const roleTypes: TermSuggestion[] = [];
  for (const [stem, members] of groups) {
    const term = members.length > 1 ? `${stem}*` : members[0]!;
    if (covered(term, gate.includeKeywords) || members.some((m) => covered(m, gate.includeKeywords))) continue;
    if (gate.excludeKeywords.some((e) => compileTerm(e)?.test(term))) continue;
    const matches = words.find(term).map((position) => candidates[position]!);
    if (matches.length >= minAdmits) roleTypes.push(toSuggestion(term, matches));
  }
  roleTypes.sort((a, b) => b.admits - a.admits || b.companies - a.companies);
  return { unmatched: unmatched.length, seniority, roleTypes: roleTypes.slice(0, limit) };
}
