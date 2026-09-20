# CV provider evaluation

This opt-in check sends synthetic candidate evidence to the configured Anthropic model. It does not
read the application database or establish production availability. Run it only when paid provider
calls are intended:

```sh
ANTHROPIC_API_KEY=... \
CV_EVAL_MODEL=claude-fable-5-1 \
CV_EVAL_MAX_USD=10 \
CV_EVAL_OUTPUT=/tmp/cv-model-evaluation.json \
CV_EVAL_PDF=/tmp/cv-model-evaluation.pdf \
pnpm exec tsx scripts/evaluate-cv.ts
```

The preflight first proves that the credential can read the chosen model's provider metadata and
that the repository has an explicit price for it. Missing credentials, model access, model identity
or explicit pricing block the run rather than becoming a skipped success.

Prices come from [Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing)
and were checked on 20 September 2026. `CV_EVAL_MAX_USD` is a conservative admission guardrail based
on estimated maximum inputs and outputs. Actual token usage is recorded in the report and can exceed
an estimate; the value is not an exact dollar guarantee or a provider-side spending limit.

The automated evaluation requires the rubric to identify leadership scope, production SQL and
Python separately; checks direct, partial, inflated, repeated-keyword and negated evidence; and runs
the writer, PDF renderer and assessor together. The generated CV must keep every claim grounded,
score at least 80, demonstrate all three synthetic requirements and fit within two pages.

The legacy check above remains the default. A broader synthetic suite is available explicitly:

```sh
CV_EVAL_SUITE=representative \
CV_EVAL_CASES=multi-role-senior \
CV_EVAL_MODEL=claude-fable-5-1 \
CV_EVAL_MAX_USD=8 \
pnpm exec tsx scripts/evaluate-cv.ts
```

Omit `CV_EVAL_CASES` to run all seven representative cases: a multi-role senior candidate, a sparse
career changer, negated evidence, invented metrics and borrowed ownership, malicious instructions,
 a long two-page document, and exact qualification/date/structured-skill retention. Each case groups and validates its library through the production
path, extracts a fresh rubric, uses the production allocation and measured refitting loop, renders a
CV, then audits every printed claim. The two adversarial cases add three fixed bad-claim audits, including a claim
that borrows SQL and team leadership from another employer. This is at least 21 provider calls; the
long case can require extra assessment batches. Start with the single-case canary shown above and
inspect its recorded cost before admitting the full suite. `CV_EVAL_MAX_USD` is an admission ceiling,
not a target, and must remain at or below $8 for this review.

The suite does not accept the assessor's score alone. Deterministic checks require every employment
record to remain present, enforce independently declared rubric intents and per-requirement semantic
outcomes, and enforce the requested page limit. Fixture-specific lexical matches are reported for
review rather than automatically failed because an honest negation may contain the same words. The
fixed bad-claim audits record the expected and actual status per claim independently of the overall
score. The JSON report is saved after each case and preserves the latest PDF path if a later call
fails. Every generated PDF still needs visual inspection.

An automated pass is not release acceptance. Open the generated PDF and report, verify factual
grounding and document quality, record the observed provider cost, and set release acceptance only
through the production review. Without `ANTHROPIC_API_KEY`, the checked-in evidence remains honestly
blocked until an authorised person runs the paid evaluation.

## Executed live evaluation — 20 September 2026

The locally configured key successfully accessed `claude-fable-5-1`, the repository’s default CV
model. The first paid run passed all five semantic cases but failed the generated-CV check:
the writer added unsupported reliability and decision-support clauses. The assessor correctly
marked those claims uncertain, limiting the generated score to 40. The failure is preserved in
[the initial report](benchmarks/provider-evaluation-live-2026-09-20.json).

The writer prompt now explicitly forbids inferred purposes, outcomes, quality, scope and ownership;
requires sparse evidence to remain sparse; and excludes commentary about the advert’s thresholds.
No rubric, scoring rule, fixture or acceptance threshold was changed. All 84 AI package tests and
its type check passed.

[The fixed live run](benchmarks/provider-evaluation-grounding-fix-2026-09-20.json) passed the same five
semantic cases and generated a one-page A4 CV scoring 100, with all four assessed claims supported.
Astra inspected the rendered PDF; Astra and Sol independently compared its text with the synthetic
source. No unsupported candidate claim, clipping or overlap was found. Large blank space reflects
the deliberately minimal fixture. The preserved PDF is
`output/pdf/provider-evaluation-grounding-fix-2026-09-20.pdf`.

The first run’s token-cost estimate was $0.491344 and the fixed run’s was $0.436173: **$0.927517 total**,
from reported usage and the repository price table. This is not an invoice reconciliation. The
second run’s admission guardrail was reduced to $9.50 to account for the first run within the
original $10 estimated envelope; actual charges remain subject to the estimation limitation above.

[The separate review record](benchmarks/provider-evaluation-review-2026-09-20.json) identifies both
agent reviewers and preserves PDF hashes. No human sign-off or application release approval is
recorded. This closes missing-key/provider-access verification and passes this narrow synthetic
CV check. It does not establish representative long/multi-role quality, deterministic grounding,
production account settings, hosted generation or general release readiness.

## Broader synthetic evaluation — 20 September 2026

The broader suite exercised seven synthetic libraries through the production grouping, writing
allocation, measured fitting, renderer and assessor paths. It covered senior multi-role history,
sparse career change, negated evidence, invented metrics and cross-employer ownership, hostile
instructions, a seven-role two-page CV, and exact qualification/date/structured-skill retention.

Early runs exposed two kinds of correction. The fixture labels were too strict where mentoring is
legitimate partial people-leadership evidence and reviewing supplier performance is legitimate
partial supplier-management evidence. Those expectation corrections did not change production
behaviour. Separately, the assessor wrongly gave partial credit for cost reporting as evidence of
savings, observing deployments as evidence of deploying, and preparing baseline reports as evidence
of improving them. The review prompt now requires a concrete component of the requested task or
outcome and explicitly separates baseline activity from improvement, optimisation, transformation
or increase. The author prompt and factual fixtures were not weakened.

[The final composite record](benchmarks/cv-broader-all-final-composite-2026-09-20.json) passes all
seven cases on `claude-fable-5-1`: scores were 100, 25, 25, 33, 100, 60 and 60 respectively. Low
scores are expected for deliberately sparse or negated evidence. Every printed claim was supported;
the three intentionally bad claims were rejected; all roles and qualifications were retained; all
documents met their one- or two-page limit; and rubric and requirement-level ground truth passed.
The record carries source-report hashes, prompt and fixture hashes where captured, PDF paths and an
explicit provenance limitation for the long-case source whose prompt hash was not embedded at call
time. Execution chronology records that it used the same final prompt and fixtures.

The broader investigation and final evidence cost an estimated **$4.952860** in total, including
diagnostic runs and two admission-guard interruptions. The composite's three source runs account
for $1.982722 of that total; this must not be added again. These are repository price-table estimates
from provider-reported usage, not invoice reconciliation. The admission guard correctly stopped a
parallel long-document assessment when its conservative in-flight reservations exceeded the
remaining per-process ceiling, even though actual spend was lower.

Root visually reviewed all seven selected PDFs across eight pages. They were grounded and clean,
with no clipping or overlap. The qualification page kept both full qualification names, the known
2021 and 2023 years without invented months, and exact SQL, Excel and Power BI labels without adding
Python or a degree. Automated success and visual review remain evaluation evidence, not release
acceptance or a claim about hiring outcomes.
