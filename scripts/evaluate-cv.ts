/** Opt-in semantic regression evaluation. Uses synthetic data and never touches the application DB. */
import { writeFileSync } from "node:fs";
import { createAiEngine } from "../packages/ai/src/index";
import { materialiseCv, type CvLibrary } from "../packages/core/src/cv";
import {
  cvTextItems,
  cvClaimItems,
  cvEvidenceItems,
} from "../packages/core/src/cv-assessment";
import {
  validateCvRubric,
  createCvAssessment,
} from "../packages/core/src/cv-review";

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY,
    model = process.env.CV_EVAL_MODEL;
  if (!apiKey || !model)
    throw new Error(
      "Set ANTHROPIC_API_KEY and CV_EVAL_MODEL to run the opt-in synthetic model evaluation.",
    );
  const cap = Number(process.env.CV_EVAL_MAX_USD ?? "2");
  if (!Number.isFinite(cap) || cap <= 0)
    throw new Error("CV_EVAL_MAX_USD must be positive.");
  let spent = 0;
  const ai = createAiEngine({
    apiKey,
    getModel: () => model,
    reserve: async (_site, estimate) =>
      spent + estimate > cap
        ? null
        : async (actual) => {
            spent += actual ?? estimate;
          },
    logger: (message) => console.error(message),
  });
  const description =
    "Required: lead a team of at least ten people. Required: use SQL in production reporting. Preferred: Python. Benefits include flexible working and a pension.";
  const extracted = await ai.analyseCvJob(description);
  if (!extracted) throw new Error("The model did not return a rubric.");
  const rubric = validateCvRubric(description, extracted);
  const cases = [
    {
      name: "direct-evidence",
      evidence:
        "Led a team of 12 people and used SQL in production reporting. Used Python for analysis.",
      claim:
        "Led a team of 12 people and used SQL in production reporting. Used Python for analysis.",
      expected: "high",
    },
    {
      name: "partial-scope",
      evidence: "Led a team of three people. Used SQL in production reporting.",
      claim: "Led a team of three people. Used SQL in production reporting.",
      expected: "below-high",
    },
    {
      name: "unsupported-inflation",
      evidence: "Assisted with reporting in Excel.",
      claim: "Led a team of 12 people and used SQL in production reporting.",
      expected: "flagged",
    },
    {
      name: "keyword-repetition",
      evidence: "Completed introductory SQL training.",
      claim: "SQL SQL SQL SQL SQL SQL SQL SQL SQL SQL.",
      expected: "below-high",
    },
    {
      name: "negation",
      evidence:
        "Have not used SQL in production. Assisted a team of 12 without managing them.",
      claim:
        "Have not used SQL in production. Assisted a team of 12 without managing them.",
      expected: "below-high",
    },
  ];
  const results = [];
  for (const item of cases) {
    const library: CvLibrary = {
      name: "Synthetic Candidate",
      contact: "",
      profile: "Reporting professional",
      entries: [
        {
          id: "role",
          kind: "experience",
          heading: "Analyst",
          details: item.evidence,
          confirmedResponsibilities: [item.evidence],
        },
      ],
    };
    const content = materialiseCv(library, {
      summary: library.profile,
      sections: [{ entryId: "role", bullets: [item.claim] }],
      gaps: [],
    });
    const review = await ai.assessCv({
      rubric,
      cv: cvTextItems(content),
      claims: cvClaimItems(content),
      evidence: cvEvidenceItems(library),
    });
    if (!review) throw new Error(`No assessment for ${item.name}`);
    const result = createCvAssessment({
      content,
      description,
      library,
      rubric,
      review,
      model,
      pageCount: 1,
    });
    const flagged = result.review.claims.some(
      (claim) => claim.status !== "supported",
    );
    const passed =
      item.expected === "flagged"
        ? flagged
        : item.expected === "high"
          ? result.score >= 80 && !flagged
          : result.score < 80;
    results.push({
      name: item.name,
      expected: item.expected,
      passed,
      assessment: result,
    });
    console.log(
      `${item.name}: ${result.score}/100; ${passed ? "PASS" : "REVIEW"}`,
    );
  }
  writeFileSync(
    process.env.CV_EVAL_OUTPUT ?? "/tmp/cv-model-evaluation.json",
    JSON.stringify({ model, spentUsd: spent, results }, null, 2),
  );
  if (results.some((item) => !item.passed)) process.exitCode = 1;
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Evaluation failed");
  process.exitCode = 1;
});
