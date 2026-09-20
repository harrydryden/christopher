/** Opt-in semantic regression evaluation. Uses synthetic data and never touches the application DB. */
import { writeFileSync } from "node:fs";
import { evaluationBudget } from "./evaluation-budget.mjs";
import { providerReadiness } from "./provider-readiness.mjs";
import {
  evaluationRequirementIds,
  gradeEvaluationCase,
  gradeGeneratedCv,
} from "./cv-evaluation-grading.mjs";
import { renderCvPdfWithReport } from "../packages/core/src/cv-pdf";
import { createAiEngine, PRICING } from "../packages/ai/src/index";
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
  const output = process.env.CV_EVAL_OUTPUT ?? "/tmp/cv-model-evaluation.json";
  const cap = Number(process.env.CV_EVAL_MAX_USD ?? "10");
  const budget = evaluationBudget(cap);
  const report: Record<string, unknown> = {
    at: new Date().toISOString(), status: "blocked", model: model ?? null,
    priceSource: "https://platform.claude.com/docs/en/about-claude/pricing",
    pricesCheckedAt: "2026-09-20", syntheticCandidate: true,
    releaseAccepted: false,
    budgetGuardrail: "The USD limit is a conservative admission estimate. Actual provider usage is recorded and can exceed the estimate; it is not an exact billing guarantee.",
  };
  const save = () => writeFileSync(output, JSON.stringify({ ...report, budget: budget.snapshot() }, null, 2) + "\n");
  if (!model) {
    report.reason = "Set CV_EVAL_MODEL to the intended production CV model.";
    save();
    throw new Error(String(report.reason));
  }
  report.provider = await providerReadiness({ apiKey, models: [model], prices: PRICING });
  if ((report.provider as {status: string}).status !== "passed") {
    save();
    throw new Error(`Provider preflight did not pass; see ${output}`);
  }
  const ai = createAiEngine({
    apiKey,
    getModel: () => model,
    reserve: budget.reserve,
    onUsage: budget.onUsage,
    logger: (message) => console.error(message),
  });
  const results: Array<Record<string, unknown>> = [];
  report.results = results;
  try {
    const description =
      "Required: lead a team of at least ten people. Required: use SQL in production reporting. Preferred: Python. Benefits include flexible working and a pension.";
    const extracted = await ai.analyseCvJob(description);
    if (!extracted) throw new Error("The model did not return a rubric.");
    const rubric = validateCvRubric(description, extracted);
    const requirementIds = evaluationRequirementIds(rubric);
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
      const claimId = cvClaimItems(content).find(claim => claim.text === item.claim)?.id;
      if (!claimId) throw new Error(`Could not identify the evaluated claim for ${item.name}.`);
      const passed = gradeEvaluationCase({ name: item.name, assessment: result, requirementIds, claimId });
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
    // A real writer/renderer/assessor run, separate from the labelled semantic cases above.
    const evidence = "Led a team of 12 people and used SQL in production reporting. Used Python for analysis.";
    const library: CvLibrary = { name: "Synthetic Candidate", contact: "London", profile: "Reporting professional",
      entries: [{ id: "role", kind: "experience", heading: "Operations Lead", details: evidence, confirmedResponsibilities: [evidence] }] };
    const plan = await ai.buildCv({ library, description, rubric, jobTitle: "Operations Lead", company: "Synthetic Company", maxPages: 2 });
    if (!plan) throw new Error("The writer did not return a CV plan.");
    const content = materialiseCv(library, plan);
    const rendered = await renderCvPdfWithReport(content);
    const review = await ai.assessCv({rubric, cv: cvTextItems(content), claims: cvClaimItems(content), evidence: cvEvidenceItems(library)});
    if (!review) throw new Error("The generated CV could not be assessed.");
    const assessment = createCvAssessment({content, description, library, rubric, review, model, pageCount: rendered.pageCount});
    const generatedPassed = gradeGeneratedCv({ assessment, requirementIds, pageCount: rendered.pageCount });
    const pdfPath = process.env.CV_EVAL_PDF ?? output.replace(/\.json$/, "") + ".pdf";
    writeFileSync(pdfPath, rendered.pdf);
    report.generatedCv = {passed: generatedPassed, pageCount: rendered.pageCount, pdfPath, content, assessment,
      humanReview: "required: inspect the generated PDF and confirm factual grounding before release"};
    report.status = results.every(item => item.passed) && generatedPassed && !budget.snapshot().exceeded ? "automated_checks_passed" : "failed";
    if (report.status !== "automated_checks_passed") process.exitCode = 1;
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.message : "Evaluation failed";
    process.exitCode = 1;
  } finally {
    save();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Evaluation failed");
  process.exitCode = 1;
});
