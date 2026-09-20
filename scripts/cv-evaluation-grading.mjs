const INTENTS = Object.freeze({
  leadership: "lead a team of at least ten people",
  sql: "use sql in production reporting",
  python: "python",
});

/** Prove the rubric grades the intended requirements rather than an easy anchored subset. */
export function evaluationRequirementIds(rubric) {
  const requirements = rubric?.requirements;
  if (!Array.isArray(requirements)) throw new Error("Evaluation rubric has no requirements.");
  const ids = {};
  for (const [intent, phrase] of Object.entries(INTENTS)) {
    const matches = requirements.filter(item => typeof item?.quote === "string" && item.quote.toLowerCase().includes(phrase));
    if (matches.length !== 1) throw new Error(`Evaluation rubric must contain exactly one ${intent} requirement.`);
    ids[intent] = matches[0].id;
  }
  if (new Set(Object.values(ids)).size !== Object.keys(INTENTS).length) {
    throw new Error("Evaluation rubric must keep leadership, SQL and Python as distinct requirements.");
  }
  if (requirements.some(item => /benefits include|flexible working|pension/i.test(item.quote))) {
    throw new Error("Evaluation rubric must not score the advert's benefits as candidate requirements.");
  }
  return ids;
}

const matchFor = (assessment, id) => assessment.review.matches.find(match => match.requirementId === id);
const demonstrated = match => match?.status === "demonstrated" && match?.libraryStatus === "demonstrated";
const notDemonstrated = match => !!match && match.status !== "demonstrated" && match.libraryStatus !== "demonstrated";
const allClaimsSupported = assessment => assessment.review.claims.length > 0 && assessment.review.claims.every(claim => claim.status === "supported");

/** Grade why a labelled semantic case passed, not merely which side of 80 its total landed on. */
export function gradeEvaluationCase({ name, assessment, requirementIds, claimId }) {
  const leadership = matchFor(assessment, requirementIds.leadership);
  const sql = matchFor(assessment, requirementIds.sql);
  const python = matchFor(assessment, requirementIds.python);
  switch (name) {
    case "direct-evidence":
      return assessment.score >= 80 && demonstrated(leadership) && demonstrated(sql) && demonstrated(python) && allClaimsSupported(assessment);
    case "partial-scope":
      return assessment.score < 80 && notDemonstrated(leadership) && demonstrated(sql) && allClaimsSupported(assessment);
    case "unsupported-inflation": {
      const claim = assessment.review.claims.find(item => item.claimId === claimId);
      return !!claim && claim.status !== "supported";
    }
    case "keyword-repetition":
      return assessment.score < 80 && notDemonstrated(sql);
    case "negation":
      return assessment.score < 80 && notDemonstrated(leadership) && notDemonstrated(sql) && allClaimsSupported(assessment);
    default:
      throw new Error(`Unknown evaluation case: ${name}`);
  }
}

/** A generated CV must be factual, fit the document limit and actually cover the synthetic role. */
export function gradeGeneratedCv({ assessment, requirementIds, pageCount }) {
  return pageCount <= 2 && assessment.score >= 80 && allClaimsSupported(assessment)
    && demonstrated(matchFor(assessment, requirementIds.leadership))
    && demonstrated(matchFor(assessment, requirementIds.sql))
    && demonstrated(matchFor(assessment, requirementIds.python));
}
