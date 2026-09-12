# CV builder review and assessment contract

Reviewed 12 September 2026. This document describes the implemented workflow and its verification boundaries.

## Findings and changes

| Area | Finding | Result |
| --- | --- | --- |
| Company description | Drafts stored text but did not identify its source. | Store the exact description plus role URL, snapshot time and whether it was pasted or taken from the company role record. A later job-page update cannot silently change a draft’s scoring basis. |
| Evidence retrieval | Confirmed/active evidence grouping existed, but writing preferences were easy to conflate with evidence. | Authoring retains style preferences; the assessor receives only grouped confirmed evidence, excluding preferences and contact details. The improvement action explicitly takes a new snapshot of the latest saved library. |
| Requirements | No explicit job rubric existed. | Independently extract distinct, quoted requirements before authoring; retain the same rubric across revisions of the same advert. Reject invented quotes, duplicate weighting and demographic criteria. |
| Authoring | One long inline prompt mixed content and layout concerns. | Centralise authoring, rubric and factual-assessment prompts. Separate metered calls use the configured CV model. Names/contact and visual configuration are injected by the application, not rewritten by the model. |
| Two-page fitting | Character budgets and measured fitting already existed. | Drive relevance with the extracted job criteria; preserve the hard two-page export limit, six bullets/650 characters, complete achievements, employment and education blocks. No clipping or font shrinkage. |
| Scoring | No CV-specific score or evidence mapping existed. | Assess final fitted wording and every printed claim. Validate each evidence quote and ID, calculate weighted coverage in code, and provide evidence-backed system improvements separately from user evidence questions. |
| Persistence | Ordinary JSON serialisation is unstable across PostgreSQL JSONB round-trips. | Canonical SHA-256 fingerprint covers the rendered content, description, grouped library and method version. Tests include key reordering. |
| Visible text | Assessment could include internal skill headings or hidden bullets. | The renderer and assessor share heading visibility, text cleaning and skill-item selection. Names, contacts, notes and decorative industry context do not contribute to the score. |
| Revisions | Ready previously meant downloadable, without assessment. | Save edits into a queued assessment revision. Fit/improve author a new revision. The finalisation action checks current assessment, factual issues and actual PDF length. Download and application creation repeat these checks. |
| Recovery | An assessment failure could discard a usable authored draft. | Persist the fitted draft before review; allow assessment-only retry without another authoring call. Queue deduplication cannot leave a retry stuck without a task. Leases fence worker writes. |
| Formatting | A legacy toggle allowed skill pills to be disabled. | Skills always use centred pills, as do company industries. Navy/default and custom palettes, Skills above Education in their combined section, fixed type sizes and page numbers remain shared across preview/export. |

## Score and actions

The displayed number is **evidence-backed coverage of this job description**, not an ATS pass rate, a hiring probability, or a replica of an employer’s private score. There is no universal pass threshold.

Each distinct essential requirement weighs 2; each desirable requirement or responsibility weighs 1. Demonstrated coverage receives 1, partial coverage 0.5, and missing/unknown coverage 0. Scores are the rounded weighted average multiplied by 100. Unknown means the documents cannot establish the answer, not that the person lacks it. Repetition cannot add points. Claims flagged unsupported or uncertain earn no CV-match credit and block finalisation until corrected and reassessed.

The same rubric evaluates the evidence snapshot independently. When it supports stronger coverage than the CV, the system can improve selection or wording. When it does not, the UI asks the user for specific evidence. Evidence-library coverage is a reference, not a promised attainable CV score: space, clarity and factual completeness still matter. The score alone never blocks an otherwise factually supported CV; users review unresolved job-fit gaps before finalising.

The requirement checklist includes exact company quotes, CV quotes, source evidence and reasoning. A full claim audit includes all printed profile/achievement/skill text. Exact-quote validation establishes provenance, not semantic truth; semantic judgements still depend on the model and user review.

## Research basis

Primary sources checked on 12 September 2026:

- [Greenhouse Talent Matching FAQ](https://support.greenhouse.io/hc/en-us/articles/41131886674075-Talent-Matching-FAQ): employer-configured criteria and importance, semantic skill matching, match categories and recruiter review. Repeated related terms do not necessarily improve matching. We adopt fixed, inspectable criteria and avoid keyword-count scoring; we do not reproduce its algorithms.
- [Workable Agent](https://help.workable.com/hc/en-us/articles/38381544828695-Using-the-Workable-Agent): structured matching criteria, differentiated must-have weighting, explicit unknown/missing information and explanations. We adopt weighted evidence coverage and specific requests for missing information. Employer tools can also use application answers and private criteria unavailable to this CV builder.

No candidate data is sent to these vendors. All model calls use the application’s existing Anthropic integration and CV model selection, with normal reservations, usage recording, timeouts and output limits. Ref types distinguish rubric, authoring and assessment calls in the usage history.

## Verification

Automated checks exercise real database migrations/actions, worker orchestration, canonical fingerprints, finalisation gates and the production renderer with deterministic model doubles. Scenarios include fresh generation, score improvement from 67 to 100 using already-confirmed SQL evidence, reuse of the original rubric, latest-library retrieval, manual reassessment without rewriting, unchanged upstream snapshots, download gating and immutable application PDFs. Adversarial cases cover invented references, duplicate requirements, omitted claims, unsupported score inflation, unknown requirements and reordered JSON keys.

PDF and browser verification must include the exported two-page layout, centred skill/industry pills, section order, page numbers, scoring explanations, mobile layout and both finalisation/blocked states. Existing recorded application PDFs retain their stored bytes.

Live model quality is a separate release check. No local Anthropic credential was available during this review, so deterministic tests do not establish real-model accuracy, calibration or wording quality. Run the opt-in model evaluation against the configured production CV model and review one real CV before relying on score changes. Model and prompt upgrades should repeat that evaluation; do not interpret score precision as validated predictive accuracy.

Opt-in synthetic evaluation (requires a populated `ANTHROPIC_API_KEY`; no credentials are printed):

```sh
CV_EVAL_MODEL=your-configured-model CV_EVAL_MAX_USD=2 pnpm exec tsx scripts/evaluate-cv.ts
```

The runner covers direct evidence, insufficient team scope, fabricated achievements, keyword repetition and explicit negation. It records the rubric, citations, claim audit, scores and failures in `/tmp/cv-model-evaluation.json`. Its broad sanity thresholds detect regressions; they are not a statistically calibrated accuracy benchmark. It enforces a per-run reservation cap and uses no real candidate data or application database.

The retrieval audit also found a model-cleaning fallback and a 30,000-character storage limit in the job crawler. New records now carry direct/model provenance and a truncation flag. CV requests reject known rewritten/truncated descriptions and ask for the complete company advert; older records with unknown provenance are labelled explicitly. Feed hashes now correspond to the stored text rather than an untruncated string. This change does not refetch or rewrite historical job descriptions.

Structured skill labels participate in content-budget ranking, including short technical terms such as AI, R and C++. The fitter enforces the allocated skill count in code while preserving complete source labels; this selection heuristic is separate from the semantic job-match score.
