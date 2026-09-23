import { describe, expect, it } from "vitest";
import { SENIORITY_VOCABULARY, suggestFromScans, type ScannedTitle, type TermSuggestion } from "./suggest-from-scans";
import { compileTerm, evaluateGate, evaluateLocation, type GateSettings } from "./gate";

const gate: GateSettings = {
  includeKeywords: ["Operations", "Strategy", "Finance"], excludeKeywords: ["Engineer", "HR"],
  seniorityKeywords: ["Director", "VP", "Head of", "Chief"], matchFields: ["title"], locationTerms: ["London", "UK"], includeRemote: true,
};
const t = (title: string, company: string, location = "London, UK"): ScannedTitle => ({ title, company, location });

describe("suggestFromScans", () => {
  const postings: ScannedTitle[] = [
    // Held back only by the seniority list: "Lead" would admit these.
    t("Operations Lead", "Acme"), t("Finance Lead, EMEA", "Acme"), t("Strategy Lead", "Beta"), t("Business Operations Lead", "Gamma"),
    // A senior role missing every include keyword, in several inflections.
    t("Director of Partnerships", "Acme"), t("Head of Partnership Development", "Beta"), t("VP Partnerships", "Gamma"),
    t("Director, Growth", "Beta"), t("Head of Growth Marketing", "Delta"), t("VP Growth", "Acme"),
    // Already admitted: not part of the pool.
    t("Head of Operations", "Acme"),
    // Outside the geography: never counted.
    t("Operations Lead", "Acme", "San Francisco, CA"), t("Director of Partnerships", "Acme", "New York, NY"),
    // Excluded: never counted as a role type.
    t("Director of HR Partnerships", "Acme"),
    // A level word alone is never a role type.
    t("Senior Manager", "Beta"), t("Director, Manager Excellence", "Beta"), t("VP Management", "Beta"),
  ];
  const result = suggestFromScans(postings, gate);

  it("counts only location-passing roles the gate does not admit", () => {
    expect(result.unmatched).toBe(14);
  });
  it("proposes seniority labels that would admit keyword-matching roles, with counts and examples", () => {
    const lead = result.seniority.find((s) => s.term === "Lead");
    expect(lead).toMatchObject({ admits: 4, companies: 3 });
    expect(lead!.examples.map((e) => e.title)).toContain("Operations Lead");
    expect(result.seniority.map((s) => s.term)).not.toContain("Director");
  });
  it("proposes role types the include list misses, as a wildcard when inflections vary", () => {
    const terms = result.roleTypes.map((s) => s.term);
    expect(terms).toContain("partnership*");
    expect(terms).toContain("growth");
    expect(result.roleTypes.find((s) => s.term === "partnership*")!.admits).toBe(3);
  });
  it("never proposes level words, excluded words, or terms an existing wildcard already covers", () => {
    const terms = result.roleTypes.map((s) => s.term);
    for (const bad of ["manager", "management", "manage*", "engineering", "director", "senior"]) expect(terms).not.toContain(bad);
    const widened = suggestFromScans(postings, { ...gate, includeKeywords: [...gate.includeKeywords, "partner*"] });
    expect(widened.roleTypes.map((s) => s.term)).not.toContain("partnership*");
  });
  it("returns nothing when there is nothing to mine", () => {
    expect(suggestFromScans([], gate)).toEqual({ unmatched: 0, seniority: [], roleTypes: [] });
  });
});

describe("suggestFromScans at scale", () => {
  // A deterministic corpus built to hit the grouping's edge cases: long shared prefixes that do
  // and do not merge, words shorter than a stem, hyphens, digits, capitals and accents.
  const vocabulary = ["strata", "strategic", "strategy", "strategist", "strategies", "partner", "partnership", "partnerships",
    "partnering", "abcdefgh", "abcdexyz", "abcdefzzzzzz", "abcdeg", "abcdefghij", "managing", "manageable", "manager",
    "growth", "growing", "grower", "revenue", "revops", "devops", "people", "peoples", "operations", "operational",
    "finance", "financial", "financing", "zürich", "Zurich", "data", "database", "databases", "co-op", "r&d", "ml2", "ml",
    "customer", "customers", "custom", "success", "successful", "program", "programme", "programmes", "programming"];
  const seniority = ["Director", "VP", "Head of", "Lead", "Senior", "Chief", ""];
  let seed = 42;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const pick = <T,>(items: T[]) => items[Math.floor(next() * items.length)]!;
  // Invented words, a few thousand of them, many sharing a stem: the size of vocabulary a large
  // employer's listings bring, and what made one regular expression per group expensive.
  const invented = (count: number) => Array.from({ length: count }, () => {
    const stem = Array.from({ length: 5 }, () => String.fromCharCode(97 + Math.floor(next() * 6))).join("");
    return stem + Array.from({ length: Math.floor(next() * 5) }, () => String.fromCharCode(97 + Math.floor(next() * 26))).join("");
  });
  const corpus = (n: number, vocabularyUsed: string[] = vocabulary): ScannedTitle[] => Array.from({ length: n }, () => {
    const words = Array.from({ length: 1 + Math.floor(next() * 4) }, () => pick(vocabularyUsed));
    const title = [pick(seniority), ...words].filter(Boolean).join(next() < 0.2 ? ", " : " ");
    return { title, company: pick(["Acme", "Beta", "Gamma", "Delta", "Epsilon"]), location: pick(["London, UK", "Remote", "New York, NY", "Manchester"]) };
  });
  const gates: GateSettings[] = [
    gate,
    { ...gate, includeKeywords: ["operations"], seniorityKeywords: [], excludeKeywords: [] },
    { ...gate, includeKeywords: ["partner*", "data"], excludeKeywords: ["manag*"], locationTerms: [] },
  ];

  it("files exactly what the one-regex-per-group implementation filed", () => {
    const pool = [...corpus(3000), ...corpus(1000, [...vocabulary, ...invented(400)])];
    for (const g of gates) {
      for (const opts of [{}, { minAdmits: 1, limit: 1000 }]) expect(suggestFromScans(pool, g, opts)).toEqual(referenceSuggest(pool, g, opts));
    }
  });
  it("mines fifty thousand titles well inside a slot's patience", () => {
    const pool = corpus(50_000, [...vocabulary, ...invented(4000)]);
    const started = performance.now();
    suggestFromScans(pool, { ...gate, locationTerms: [] }, { minAdmits: 1, limit: 1000 });
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

// ---------------------------------------------------------------------------------------------
// The implementation before the word index and the blocked grouping, kept verbatim as the
// reference the current one must agree with.
// ---------------------------------------------------------------------------------------------
type ReferenceResult = ReturnType<typeof suggestFromScans>;
/** Words that describe a level or a job noun, not a field of work. Never proposed as a role type. */
const REF_LEVEL_WORDS = new Set([
  ...SENIORITY_VOCABULARY.map((w) => w.toLowerCase()), "of", "and", "the", "for", "in", "to", "a", "an", "at", "with", "on",
  "manager", "management", "lead", "leader", "leadership", "senior", "junior", "associate", "assistant", "analyst", "specialist",
  "coordinator", "executive", "officer", "intern", "internship", "graduate", "apprentice", "trainee", "head", "director",
  "consultant", "advisor", "adviser", "engineer", "engineering", "team", "role", "roles", "job", "jobs", "position", "positions",
  "us", "uk", "emea", "europe", "london", "remote", "hybrid", "global", "international", "regional", "new", "group", "ii", "iii", "iv",
  "i", "ii", "sr", "jr", "staff", "principal", "vp", "svp", "evp", "chief", "president", "partner", "founding", "general",
]);

function refTokens(title: string): string[] {
  return title.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/[\s-]+/).filter((w) => w.length >= 3 && !REF_LEVEL_WORDS.has(w) && !/^\d+$/.test(w));
}

function refCovered(term: string, existing: string[]): boolean {
  const re = compileTerm(term);
  if (!re) return true;
  // Already listed verbatim, or an existing wildcard/phrase already matches this word.
  return existing.some((e) => e.trim().toLowerCase() === term.toLowerCase() || (compileTerm(e)?.test(term) ?? false));
}

function refCollect(pool: ScannedTitle[], key: (t: ScannedTitle) => string[]): Map<string, ScannedTitle[]> {
  const map = new Map<string, ScannedTitle[]>();
  for (const posting of pool) for (const k of new Set(key(posting))) (map.get(k) ?? map.set(k, []).get(k)!).push(posting);
  return map;
}

function refToSuggestion(term: string, matches: ScannedTitle[]): TermSuggestion {
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
 */
function refWildcardGroups(words: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  const sorted = [...new Set(words)].sort();
  for (const word of sorted) {
    let placed = false;
    for (const [stem, members] of groups) {
      const shared = refCommonPrefix(stem, word);
      if (shared.length >= 5 && shared.length >= Math.min(stem.length, word.length) - 3) {
        groups.delete(stem);
        groups.set(shared, [...members, word]);
        placed = true;
        break;
      }
    }
    if (!placed) groups.set(word, [word]);
  }
  return groups;
}

function refCommonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

function referenceSuggest(postings: ScannedTitle[], gate: GateSettings, opts: { minAdmits?: number; limit?: number } = {}): ReferenceResult {
  const minAdmits = opts.minAdmits ?? 3;
  const limit = opts.limit ?? 8;
  const inGeography = postings.filter((p) => evaluateLocation(p, gate).ok);
  const unmatched = inGeography.filter((p) => !evaluateGate(p, gate).inTable);

  // Seniority: roles the keywords and location already accept, held back only by the level list.
  const heldBySeniority = unmatched.filter((p) => {
    const g = evaluateGate(p, { ...gate, seniorityKeywords: [] });
    return g.inTable;
  });
  const seniority = SENIORITY_VOCABULARY
    .filter((label) => !refCovered(label, gate.seniorityKeywords ?? []))
    .map((label) => {
      const re = compileTerm(label)!;
      return refToSuggestion(label, heldBySeniority.filter((p) => re.test(p.title)));
    })
    .filter((s) => s.admits >= minAdmits)
    .sort((a, b) => b.admits - a.admits)
    .slice(0, limit);

  // Role types: frequent title words in the geography, seniority-passing when a
  // seniority list exists, that no include term covers and no exclude term hits.
  // With no include terms the gate reduces to location, exclusions and
  // seniority — exactly the pool a new role term would have to admit from.
  const candidates = unmatched.filter((p) => evaluateGate(p, { ...gate, includeKeywords: [] }).inTable);
  const byWord = refCollect(candidates, (p) => refTokens(p.title));
  // Group every word first: a single "partnership" beside two "partnerships" is
  // what makes the wildcard worth proposing, so the count threshold applies to
  // the group, never the word.
  const groups = refWildcardGroups([...byWord.keys()]);
  const roleTypes: TermSuggestion[] = [];
  for (const [stem, members] of groups) {
    const term = members.length > 1 ? `${stem}*` : members[0]!;
    if (refCovered(term, gate.includeKeywords) || members.some((m) => refCovered(m, gate.includeKeywords))) continue;
    const re = compileTerm(term)!;
    if (gate.excludeKeywords.some((e) => compileTerm(e)?.test(term))) continue;
    const matches = candidates.filter((p) => re.test(p.title));
    if (matches.length >= minAdmits) roleTypes.push(refToSuggestion(term, matches));
  }
  roleTypes.sort((a, b) => b.admits - a.admits || b.companies - a.companies);
  return { unmatched: unmatched.length, seniority, roleTypes: roleTypes.slice(0, limit) };
}
