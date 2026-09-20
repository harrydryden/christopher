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
