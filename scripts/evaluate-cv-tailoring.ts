/**
 * Opt-in, paid synthetic evaluation of the semantic CV planning path.
 * It never reads or writes the production database and never prints credentials.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createAiEngine, PRICING, type AiUsageRecord } from "../packages/ai/src/index";
import { buildFittedCv } from "../packages/core/src/cv-fit";
import { cvRelevanceTerms, type CvSemanticTarget } from "../packages/core/src/cv-budget";
import { CvLibrarySchema, materialiseCv, type CvContent, type CvLibrary, type CvPlan } from "../packages/core/src/cv";
import { cvClaimItems, cvEvidenceItems, cvTextItems, type CvRubric } from "../packages/core/src/cv-assessment";
import { createCvAssessment, validateCvRubric } from "../packages/core/src/cv-review";
import { cvTailoringEvidence } from "../packages/core/src/cv-tailoring";
import { renderCvPdfWithReport } from "../packages/core/src/cv-pdf";
import { providerReadiness } from "./provider-readiness.mjs";
import { sharedContrastLibrary, sameLibraryRoleContrasts } from "./cv-quality-contrast-fixtures.mjs";
import { blindedPairwiseCsv, gradeSameLibraryContrasts } from "./cv-quality-contrast.mjs";

// The release env file intentionally tolerates whitespace around `=` and is parsed in-process so
// credentials are never executed as shell text or echoed by a shell error.
if (!process.env.ANTHROPIC_API_KEY || !process.env.CV_EVAL_MODEL) {
  try {
    for (const line of readFileSync(".env.release-evaluation.local", "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || process.env[match[1]!]) continue;
      const raw = match[2]!;
      process.env[match[1]!] = /^(['"]).*\1$/.test(raw) ? raw.slice(1, -1) : raw;
    }
  } catch { /* The explicit configuration error below is clearer than a missing optional file. */ }
}

const ABSOLUTE_CAP_USD = 3.5;
const outputDir = resolve(process.env.CV_TAILORING_EVAL_DIR ?? "docs/evaluations/cv-tailoring-contrast");
const reportPath = resolve(outputDir, "report.json");
const markdownPath = resolve(outputDir, "README.md");
const blindPath = resolve(outputDir, "blinded-review.csv");
const keyPath = resolve(outputDir, "blinded-review-key.json");

const descriptions: Record<string, string> = {
  "strategy-director": "The Strategy Director must set portfolio priorities and build investment cases across multiple markets. They must lead launches of new growth channels with product and commercial teams.",
  "operations-director": "The Operations Director must lead and coach a multidisciplinary team. They must establish governance and risk reviews for regulated delivery, and coordinate launches with sales and local operations.",
  "analytics-lead": "The Analytics Lead must build SQL reporting used for timely business decisions. They must show a measurable improvement in reporting or decision speed.",
};

const rubrics: Record<string, CvRubric> = {
  "strategy-director": { caveats: [], requirements: [
    { id: "r1", label: "Portfolio priorities and investment cases", quote: "set portfolio priorities and build investment cases across multiple markets", importance: "essential", category: "delivery" },
    { id: "r2", label: "New growth channel launches", quote: "lead launches of new growth channels with product and commercial teams", importance: "essential", category: "delivery" },
  ] },
  "operations-director": { caveats: [], requirements: [
    { id: "r1", label: "Multidisciplinary team leadership", quote: "lead and coach a multidisciplinary team", importance: "essential", category: "experience" },
    { id: "r2", label: "Governance and risk", quote: "establish governance and risk reviews for regulated delivery", importance: "essential", category: "delivery" },
    { id: "r3", label: "Cross-functional launches", quote: "coordinate launches with sales and local operations", importance: "responsibility", category: "delivery" },
  ] },
  "analytics-lead": { caveats: [], requirements: [
    { id: "r1", label: "SQL reporting for decisions", quote: "build SQL reporting used for timely business decisions", importance: "essential", category: "skills" },
    { id: "r2", label: "Measurable reporting improvement", quote: "show a measurable improvement in reporting or decision speed", importance: "essential", category: "delivery" },
  ] },
};

function sharedLibrary(): CvLibrary {
  const evidence = new Map(sharedContrastLibrary.evidence.map((item: { id: string; text: string }) => [item.id, item.text]));
  return CvLibrarySchema.parse({
    name: sharedContrastLibrary.candidate,
    contact: "London · synthetic@example.invalid",
    profile: "Commercial, operations and analytics leader.",
    employment: [
      { id: "growth-job", company: "Synthetic Growth Co", jobTitle: "Growth Director", startDate: "2022", endDate: "", current: true },
      { id: "operations-job", company: "Synthetic Operations Co", jobTitle: "Operations Lead", startDate: "2019", endDate: "2022", current: false },
      { id: "analytics-job", company: "Synthetic Data Co", jobTitle: "Senior Analyst", startDate: "2016", endDate: "2019", current: false },
    ],
    entries: [
      { id: "growth", kind: "experience", status: "active", heading: "Growth Director", employmentId: "growth-job",
        details: `${evidence.get("portfolio")}\n${evidence.get("launch")}`, confirmedResponsibilities: [evidence.get("portfolio"), evidence.get("launch")] },
      { id: "operations", kind: "experience", status: "active", heading: "Operations Lead", employmentId: "operations-job",
        details: `${evidence.get("people")}\n${evidence.get("risk")}`, confirmedResponsibilities: [evidence.get("people"), evidence.get("risk")] },
      { id: "analytics", kind: "experience", status: "active", heading: "Senior Analyst", employmentId: "analytics-job",
        details: evidence.get("analytics"), confirmedResponsibilities: [evidence.get("analytics")] },
    ],
  });
}

function baselinePlan(library: CvLibrary): CvPlan {
  return {
    summary: library.profile,
    sections: library.entries.map(entry => ({ entryId: entry.id, bullets: entry.details.split("\n").filter(Boolean) })),
    gaps: [],
  };
}

const sourceToFixture: Record<string, string> = {
  "entry:growth:row:0": "portfolio", "entry:growth:row:1": "launch",
  "entry:operations:row:0": "people", "entry:operations:row:1": "risk",
  "entry:analytics:row:0": "analytics",
};
const contentText = (content: CvContent) => [content.summary, ...content.sections.flatMap(section => section.bullets)].join("\n");
const refs = (content: CvContent) => [
  ...(content.summarySources ?? []),
  ...content.sections.flatMap(section => section.bulletSources?.flat() ?? []),
];

async function main() {
  mkdirSync(outputDir, { recursive: true });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.CV_EVAL_MODEL;
  const requestedCap = Number(process.env.CV_TAILORING_EVAL_MAX_USD ?? ABSOLUTE_CAP_USD);
  const capUsd = Math.min(ABSOLUTE_CAP_USD, Number.isFinite(requestedCap) ? requestedCap : ABSOLUTE_CAP_USD);
  const priorSpendUsd = Math.max(0, Number(process.env.CV_TAILORING_EVAL_PRIOR_SPEND_USD ?? 0));
  let spentUsd = priorSpendUsd;
  let heldUsd = 0;
  const usage: AiUsageRecord[] = [];
  const report: Record<string, unknown> = {
    at: new Date().toISOString(), status: "running", syntheticCandidate: true, model: model ?? null,
    capUsd, priorSpendUsd, paidCallsAuthorised: true, humanReview: "not performed",
    baselineControl: "Literal Library profile and evidence rows; not output from the previous production authoring engine and not an old-versus-new engine comparison.",
    flow: "fixed rubric → semantic evidence plan → provenance-validated author → deterministic semantic fit → factual assessment",
    reproducibility: {
      gitHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      gitDirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
      scriptSha256: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex"),
    },
    cases: [],
  };
  const save = () => writeFileSync(reportPath, JSON.stringify({ ...report, budget: { capUsd, spentUsd, heldUsd, remainingUsd: Math.max(0, capUsd - spentUsd - heldUsd), calls: usage } }, null, 2) + "\n");
  save();
  if (!model || !apiKey) throw new Error("CV_EVAL_MODEL and ANTHROPIC_API_KEY must be configured.");
  const readiness = await providerReadiness({ apiKey, models: [model], prices: PRICING });
  report.provider = readiness;
  if (readiness.status !== "passed") throw new Error("Provider preflight did not pass.");

  const ai = createAiEngine({
    apiKey, getModel: () => model,
    reserve: async (_site, estimate) => {
      if (!Number.isFinite(estimate) || estimate <= 0 || spentUsd + heldUsd + estimate > capUsd) return null;
      heldUsd += estimate; save();
      let released = false;
      return async () => { if (!released) { released = true; heldUsd = Math.max(0, heldUsd - estimate); save(); } };
    },
    onUsage: record => {
      spentUsd += record.costUsd;
      usage.push(record);
      if (spentUsd > capUsd + 1e-9) throw new Error("Hard evaluation spend cap exceeded.");
      save();
    },
    logger: message => console.error(message),
  });
  const library = sharedLibrary();
  const baseline = materialiseCv(library, baselinePlan(library));
  const outputs: Record<string, { text: string; selectedEvidenceIds: string[]; leadingEvidenceId?: string }> = {};
  const pairs: Array<{ id: string; role: string; baseline: string; candidate: string }> = [];
  const key: Array<{ pairId: string; versionA: "baseline" | "tailored"; versionB: "baseline" | "tailored" }> = [];

  for (const [index, role] of sameLibraryRoleContrasts.entries()) {
    const caseReport: Record<string, unknown> = { roleId: role.id, title: role.title, status: "running", callStart: usage.length };
    (report.cases as Array<Record<string, unknown>>).push(caseReport); save();
    try {
      const description = descriptions[role.id]!;
      const rubric = validateCvRubric(description, rubrics[role.id]);
      const plan = await ai.planCvTailoring({ rubric, library }, { refType: "synthetic-cv-evaluation", refId: role.id, stage: "planning" });
      if (!plan) throw new Error("Evidence planner returned no result.");
      const semantic: CvSemanticTarget = { plan, rubric };
      const content = await buildFittedCv(library, cvRelevanceTerms(rubric.requirements), async input => {
        const authored = await ai.buildCv({ library, jobTitle: role.title, company: "Synthetic Hiring Company", description, rubric, tailoringPlan: plan, ...input },
          { refType: "synthetic-cv-evaluation", refId: role.id, stage: "author" });
        if (!authored) throw new Error("Author returned no result.");
        return authored;
      }, undefined, undefined, semantic);
      const rendered = await renderCvPdfWithReport(content);
      const review = await ai.assessCv({ rubric, cv: cvTextItems(content), claims: cvClaimItems(content), evidence: cvEvidenceItems(library) },
        { refType: "synthetic-cv-evaluation", refId: role.id, stage: "assessment" });
      if (!review) throw new Error("Assessment returned no result.");
      const assessment = createCvAssessment({ content, description, library, rubric, review, model, pageCount: rendered.pageCount });
      const allCareersPreserved = ["growth", "operations", "analytics"].every(id => content.sections.some(section => section.entryId === id));
      const claimsSupported = assessment.review.claims.every(claim => claim.status === "supported");
      const plannedSources = new Set(plan.requirements.flatMap(requirement => requirement.evidence.map(item => item.sourceId)));
      const selectedEvidenceIds = [...new Set([...plannedSources].map(id => sourceToFixture[id]).filter((id): id is string => !!id))];
      const orderedRefs = refs(content).map(ref => ref.sourceId);
      const leadingSource = orderedRefs.find(id => plannedSources.has(id) && !!sourceToFixture[id]);
      const leadingEvidenceId = leadingSource ? sourceToFixture[leadingSource] : undefined;
      const emphasisText = [content.summary, ...content.sections.flatMap(section => section.bullets.filter((_, bullet) =>
        section.bulletSources?.[bullet]?.some(source => plannedSources.has(source.sourceId))))].join("\n");
      outputs[role.id] = { text: emphasisText, selectedEvidenceIds, ...(leadingEvidenceId ? { leadingEvidenceId } : {}) };
      pairs.push({ id: role.id, role: role.title, baseline: contentText(baseline), candidate: contentText(content) });
      key.push({ pairId: role.id, versionA: index % 2 ? "tailored" : "baseline", versionB: index % 2 ? "baseline" : "tailored" });
      const pdfPath = resolve(outputDir, `${role.id}.pdf`); writeFileSync(pdfPath, rendered.pdf);
      Object.assign(caseReport, { status: allCareersPreserved && claimsSupported ? "passed" : "review", pageCount: rendered.pageCount,
        allCareersPreserved, claimsSupported, score: assessment.score, availableEvidenceScore: assessment.availableEvidenceScore,
        tailoringPlan: plan, gapQuestions: plan.gapQuestions, selectedEvidenceIds, leadingEvidenceId: leadingEvidenceId ?? null,
        callEnd: usage.length, calls: usage.slice(Number(caseReport.callStart)), content, assessment, pdfPath });
    } catch (error) {
      Object.assign(caseReport, { status: "failed", error: error instanceof Error ? error.message : "Unknown failure", callEnd: usage.length,
        calls: usage.slice(Number(caseReport.callStart)) });
      save();
      if (/budget|spend cap/i.test(String(caseReport.error))) break;
    }
    save();
  }
  report.contrast = gradeSameLibraryContrasts(outputs);
  writeFileSync(blindPath, blindedPairwiseCsv(pairs) + "\n");
  writeFileSync(keyPath, JSON.stringify({ warning: "Blinding key only; no human review was performed.", pairs: key }, null, 2) + "\n");
  const cases = report.cases as Array<{ status: string }>;
  report.status = cases.length === 3 && cases.every(item => item.status === "passed") && (report.contrast as { passed: boolean }).passed
    ? "automated_checks_passed" : cases.length < 3 ? "incomplete_budget_guard" : "review_required";
  report.humanReview = "Blinded pack prepared with blank preference fields; no human judgement has been recorded.";
  writeFileSync(markdownPath, `# Synthetic CV tailoring contrast\n\nGenerated ${new Date().toISOString()}. This is an automated synthetic evaluation; no human review has been performed.\n\n- Status: **${report.status}**\n- Model: ${model}\n- Cumulative spend for this subtask: $${spentUsd.toFixed(4)} of the $${capUsd.toFixed(2)} hard cap${priorSpendUsd ? ` (including $${priorSpendUsd.toFixed(4)} from the superseded first run)` : ""}\n- Completed roles: ${cases.length}/3\n- Distinct semantic plans: ${(report.contrast as { distinctPlans?: boolean }).distinctPlans ? "yes" : "no"}\n- Blinded review: [blinded-review.csv](./blinded-review.csv)\n- Separate key: [blinded-review-key.json](./blinded-review-key.json)\n- Full machine report: [report.json](./report.json)\n\nThe baseline is a literal Library-derived control containing the stored profile and evidence rows. It is not output from the previous production authoring engine, so this comparison does not measure an old-versus-new engine quality gain. The preference columns are intentionally blank and human review remains pending.\n`);
  save();
  if (report.status !== "automated_checks_passed") process.exitCode = 1;
}

main().catch(error => {
  mkdirSync(dirname(reportPath), { recursive: true });
  console.error(error instanceof Error ? error.message : "Evaluation failed");
  process.exitCode = 1;
});
