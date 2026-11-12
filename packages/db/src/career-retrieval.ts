import type { CvRubric } from "@col/core/cv-assessment";

/** Deterministic contextual retrieval, version 1. It ranks eligible source text; it does not establish facts. */
export const CAREER_RETRIEVAL_VERSION = "career-context-v1";
export type CareerRetrievalRequirement = {
  id: string;
  text: string;
  kind: "essential" | "desirable" | "responsibility";
  rank?: number;
  /** User or advert vocabulary used only to find source wording, never as CV evidence. */
  searchHints?: string[];
};

export type CareerRetrievalContext = {
  version: 1;
  requirements: CareerRetrievalRequirement[];
  /** Search vocabulary only. In particular, skill labels are not proof of delivery. */
  searchHints?: string[];
};

export function careerRetrievalContextFromRubric(rubric: CvRubric): CareerRetrievalContext {
  return { version: 1, requirements: rubric.requirements.filter(row => row.category !== "logistics")
    .map(row => ({ id: row.id, text: row.label, kind: row.importance, ...(row.rank ? { rank: row.rank } : {}) })) };
}

// Narrow equivalences help recall without claiming that either phrase proves a requirement.
const concepts: readonly (readonly string[])[] = [
  ["people management", "line management", "direct reports"],
  ["incident response", "incident handling"],
  ["stakeholder management", "stakeholder engagement"],
  ["project management", "programme delivery", "program delivery"],
  ["continuous improvement", "process improvement"],
  ["data analysis", "data analytics"],
  ["budget management", "budget oversight"],
  ["cybersecurity", "cyber security"],
];

const normalise = (value: string) => value.toLocaleLowerCase("en-GB").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const normalisedConcepts = concepts.map(group => group.map(normalise));
type SearchText = { words: Set<string>; concepts: Set<number> };
function compileText(value: string): SearchText {
  const normal = normalise(value);
  const padded = ` ${normal} `;
  return { words: new Set(normal.split(/\s+/).filter(word => word.length >= 3)),
    concepts: new Set(normalisedConcepts.flatMap((group, index) =>
      group.some(phrase => padded.includes(` ${phrase} `)) ? [index] : [])) };
}

function overlap(source: SearchText, query: SearchText): number {
  let score = 0;
  for (const word of query.words) if (source.words.has(word)) score++;
  for (const concept of query.concepts) if (source.concepts.has(concept)) score += 2;
  return score;
}

const requirementWeight = (requirement: CareerRetrievalRequirement) =>
  (requirement.kind === "essential" ? 5 : requirement.kind === "desirable" ? 3 : 2) *
  (requirement.rank ? Math.max(1, 6 - Math.min(5, requirement.rank)) : 1);

export function compileCareerRetrieval(roleText: string, priorityTerms: string[], context?: CareerRetrievalContext) {
  const role = compileText(roleText);
  const priorities = priorityTerms.map(compileText);
  const hints = context?.searchHints?.map(compileText) ?? [];
  const requirements = context?.version === 1 ? context.requirements.map(requirement => ({
    direct: compileText(requirement.text), hints: requirement.searchHints?.map(compileText) ?? [],
    weight: requirementWeight(requirement),
  })) : [];
  const cache = new Map<string, { score: number; coverage: number[] }>();
  return (sourceText: string) => {
    const cached = cache.get(sourceText);
    if (cached) return cached;
    const source = compileText(sourceText);
    const priority = priorities.reduce((sum, query) => sum + overlap(source, query), 0);
    const broad = overlap(source, role);
    const hintScore = hints.reduce((sum, query) => sum + overlap(source, query), 0);
    const coverage = requirements.map(requirement => Math.max(overlap(source, requirement.direct),
      ...requirement.hints.map(hint => overlap(source, hint))));
    const weighted = coverage.reduce((sum, match, index) => sum + Math.min(match, 4) * requirements[index]!.weight, 0);
    const result = { score: weighted + priority * 4 + broad + hintScore, coverage };
    cache.set(sourceText, result);
    return result;
  };
}

export function careerRetrievalScores(source: string, roleText: string, priorityTerms: string[],
  context?: CareerRetrievalContext): { score: number; coverage: number[] } {
  return compileCareerRetrieval(roleText, priorityTerms, context)(source);
}

/** Prefer evidence for requirements not yet represented when an output cap is reached. */
export function rankCareerEvidence<T>(items: T[], getText: (item: T) => string,
  roleText: string, priorityTerms: string[], context?: CareerRetrievalContext,
  extraScore: (item: T) => number = () => 0,
  scoreSource = compileCareerRetrieval(roleText, priorityTerms, context)): T[] {
  const remaining = items.map((item, index) => ({ item, index,
    ...scoreSource(getText(item)), extra: extraScore(item) }));
  const byScore = (a: typeof remaining[number], b: typeof remaining[number]) =>
    b.score + b.extra - a.score - a.extra || a.index - b.index;
  const coverable = new Set(remaining.flatMap(row => row.coverage.flatMap((match, index) => match ? [index] : [])));
  if (!coverable.size) return remaining.sort(byScore).map(row => row.item);
  const covered = new Set<number>();
  const noveltyWeights = context?.requirements.map(requirementWeight) ?? [];
  const ranked: T[] = [];
  while (remaining.length) {
    if (covered.size === coverable.size) {
      ranked.push(...remaining.sort(byScore).map(row => row.item));
      break;
    }
    let best = 0, bestNovel = -1, bestScore = -Infinity;
    for (let index = 0; index < remaining.length; index++) {
      const candidate = remaining[index]!;
      const novel = candidate.coverage.reduce((sum, match, requirement) =>
        sum + (match && !covered.has(requirement) ? noveltyWeights[requirement] ?? 0 : 0), 0);
      const score = candidate.score + candidate.extra;
      if (novel > bestNovel || (novel === bestNovel && (score > bestScore ||
        (score === bestScore && candidate.index < remaining[best]!.index)))) {
        best = index; bestNovel = novel; bestScore = score;
      }
    }
    const [selected] = remaining.splice(best, 1);
    ranked.push(selected!.item);
    selected!.coverage.forEach((match, index) => { if (match) covered.add(index); });
  }
  return ranked;
}
