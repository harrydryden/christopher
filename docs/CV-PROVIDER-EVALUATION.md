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
