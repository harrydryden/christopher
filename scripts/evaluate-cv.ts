/** Opt-in semantic regression evaluation. Uses synthetic data and never touches the application DB. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { evaluationBudget } from "./evaluation-budget.mjs";
import { providerReadiness } from "./provider-readiness.mjs";
import {
  evaluationRequirementIds,
  gradeEvaluationCase,
  gradeGeneratedCv,
} from "./cv-evaluation-grading.mjs";
import { renderCvPdfWithReport } from "../packages/core/src/cv-pdf";
import { createAiEngine, PRICING } from "../packages/ai/src/index";
import { CvLibrarySchema, groupCvLibrary, materialiseCv, type CvLibrary } from "../packages/core/src/cv";
import { cvRelevanceTerms } from "../packages/core/src/cv-budget";
import { buildFittedCv } from "../packages/core/src/cv-fit";
import { DEFAULT_CV_THEME } from "../packages/core/src/cv-theme";
import {
  cvTextItems,
  cvClaimItems,
  cvEvidenceItems,
} from "../packages/core/src/cv-assessment";
import {
  validateCvRubric,
  createCvAssessment,
} from "../packages/core/src/cv-review";
import {
  gradeRepresentativeContent,
  gradeRepresentativeRequirements,
  gradeRepresentativeRubric,
  representativeCvCases,
} from "./cv-evaluation-fixtures.mjs";

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY,
    model = process.env.CV_EVAL_MODEL;
  const output = process.env.CV_EVAL_OUTPUT ?? "/tmp/cv-model-evaluation.json";
  const cap = Number(process.env.CV_EVAL_MAX_USD ?? "10");
  const suite = process.env.CV_EVAL_SUITE ?? "legacy";
  if (!["legacy", "representative", "all"].includes(suite)) {
    throw new Error("CV_EVAL_SUITE must be legacy, representative or all.");
  }
  const budget = evaluationBudget(cap);
  const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const report: Record<string, unknown> = {
    at: new Date().toISOString(), status: "blocked", model: model ?? null,
    priceSource: "https://platform.claude.com/docs/en/about-claude/pricing",
    pricesCheckedAt: "2026-09-20", syntheticCandidate: true,
    releaseAccepted: false, suite,
    reproducibility: {
      cvPromptsSha256: sha256("packages/ai/src/cv-prompts.ts"),
      fixturesSha256: sha256("scripts/cv-evaluation-fixtures.mjs"),
      gitHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      gitDirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
    },
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
    if (suite === "legacy" || suite === "all") {
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
    }

    if (suite === "representative" || suite === "all") {
      const selectedNames = new Set((process.env.CV_EVAL_CASES ?? "").split(",").map(value => value.trim()).filter(Boolean));
      const selected = selectedNames.size
        ? representativeCvCases.filter(item => selectedNames.has(item.name))
        : representativeCvCases;
      const unknown = [...selectedNames].filter(name => !representativeCvCases.some(item => item.name === name));
      if (unknown.length) throw new Error(`Unknown representative CV cases: ${unknown.join(", ")}`);
      if (!selected.length) throw new Error("No representative CV cases were selected.");
      const representativeResults: Array<Record<string, unknown>> = [];
      report.representativeResults = representativeResults;
      for (const testCase of selected) {
        const caseReport: Record<string, unknown> = { name: testCase.name, status: "running" };
        representativeResults.push(caseReport);
        save();
        const library = groupCvLibrary(CvLibrarySchema.parse({
          ...testCase.library,
          theme: { ...DEFAULT_CV_THEME, maxPages: testCase.maxPages },
        }));
        const rubricOutput = await ai.analyseCvJob(testCase.description);
        if (!rubricOutput) throw new Error(`No rubric for ${testCase.name}.`);
        const rubric = validateCvRubric(testCase.description, rubricOutput);
        const rubricGroundTruth = gradeRepresentativeRubric(testCase, rubric);
        if (!rubricGroundTruth.passed) {
          Object.assign(caseReport, { status: "failed", rubricGroundTruth });
          save();
          throw new Error(`Rubric ground truth failed for ${testCase.name}.`);
        }
        const content = await buildFittedCv(
          library,
          cvRelevanceTerms(rubric.requirements),
          async input => {
            const plan = await ai.buildCv({
              library,
              description: testCase.description,
              rubric,
              jobTitle: testCase.jobTitle,
              company: testCase.company,
              ...input,
            });
            if (!plan) throw new Error(`No CV plan for ${testCase.name}.`);
            return plan;
          },
        );
        const rendered = await renderCvPdfWithReport(content);
        const pdfPath = output.replace(/\.json$/, "") + `-${testCase.name}.pdf`;
        writeFileSync(pdfPath, rendered.pdf);
        const deterministic = gradeRepresentativeContent(testCase, content, rendered.pageCount);
        Object.assign(caseReport, { pdfPath, deterministic, rubricGroundTruth });
        save();
        const review = await ai.assessCv({ rubric, cv: cvTextItems(content), claims: cvClaimItems(content), evidence: cvEvidenceItems(library) });
        if (!review) throw new Error(`No assessment for ${testCase.name}.`);
        const assessment = createCvAssessment({ content, description: testCase.description, library, rubric, review, model, pageCount: rendered.pageCount });
        const assessorPassed = assessment.review.claims.length > 0 && assessment.review.claims.every(claim => claim.status === "supported");
        const requirementGroundTruth = gradeRepresentativeRequirements(testCase, assessment, rubricGroundTruth.intentIds);
        const claimFlags: Array<Record<string, unknown>> = [];
        for (const expected of testCase.groundTruth.expectedClaimFlags ?? []) {
          const auditContent = materialiseCv(library, {
            summary: "Synthetic factual-audit fixture.", gaps: [],
            sections: [{ entryId: expected.entryId, bullets: [expected.claim] }],
          });
          const auditReview = await ai.assessCv({ rubric, cv: cvTextItems(auditContent), claims: cvClaimItems(auditContent), evidence: cvEvidenceItems(library) });
          if (!auditReview) throw new Error(`No claim audit for ${testCase.name}.`);
          const claimId = cvClaimItems(auditContent).find(item => item.text === expected.claim)?.id;
          const finding = auditReview.claims.find(item => item.claimId === claimId);
          claimFlags.push({ ...expected, actual: finding?.status ?? "missing", passed: !!finding && finding.status !== "supported" });
        }
        const passed = deterministic.passed && rubricGroundTruth.passed && requirementGroundTruth.passed && assessorPassed && claimFlags.every(item => item.passed);
        Object.assign(caseReport, { status: passed ? "passed" : "failed", passed, deterministic, rubricGroundTruth,
          requirementGroundTruth, assessorPassed, claimFlags, pdfPath, content, assessment,
          humanReview: "required: inspect this generated PDF for layout, lexical review flags and factual grounding" });
        save();
        console.log(`${testCase.name}: ${assessment.score}/100; ${passed ? "PASS" : "REVIEW"}`);
      }
    }
    const legacyPassed = suite === "representative" || (results.every(item => item.passed) && (report.generatedCv as {passed?: boolean} | undefined)?.passed === true);
    const representativePassed = suite === "legacy" || (report.representativeResults as Array<{passed: boolean}> | undefined)?.every(item => item.passed) === true;
    report.status = legacyPassed && representativePassed && !budget.snapshot().exceeded ? "automated_checks_passed" : "failed";
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
