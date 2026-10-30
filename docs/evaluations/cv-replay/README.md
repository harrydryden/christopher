# CV replay report

`report.json` is the evaluation report CI holds to the shipped prompt set (`scripts/check-evaluation-reports.ts`; see `docs/DEPLOY.md`). The current report qualifies prompt set **`951386df60b9`** using genuine provider responses for an invented candidate and role. It published supported claims within the selected two-page maximum, passed all four replay invariants and had no missing recorded calls.

The confirmed targeting brief features the current role, summarises one earlier role in a single sourced bullet and omits another role. The final claim audit sees only eligible evidence; full-library requirement verdicts remain a separate assessment. The exact one-page PDF, content/layout report and scope/cost notes are in `../cv-targeted-2026-10-30/`. The summary's four measured lines exceed the editorial guide; this remains visible feedback rather than a hard build failure.

The rubric and initial plan are cached synthetic fixture inputs, not live-qualified extraction stages. Two author responses were originally called live; a bounded continuation reused both only after exact request, model, prompt and provider-provenance checks and made two fresh review calls on the final policy. The report's four calls and $0.729880 cost include those reused author responses. Offline replay wall time is not live provider latency. The separate live skill probe in `../cv-skill-live-probe.json` passed with ten suggestions across four categories; replay alone does not exercise skill stages or selected-only persistence. The shared $10 ledger settled at $1.354135 across the initial run and final continuation, which added $0.471457. No customer data or production database was used.

## Historical evidence

- `report-live-2026-10-30-before-eligible-audit.json` retains the first passing run before the final separation of printed-claim eligibility from full-library scoring; it does not qualify that later input policy.
- `report-live-2026-10-28-pre-targeting.json` retains the previously current qualification at prompt set `987e0b5ac958`.
- `report-live-2026-10-28.json` retains an earlier verified replay at its original prompt set.
- `failed-scripted-comparison.json` retains the earlier failure against an optimistic scripted baseline: regulated-environment experience was partial rather than fully met. It is not treated as a passing comparison.
- Earlier skill results, including the rejected response that exhausted its token ceiling, are retained alongside the current skill probe. Historical results are not re-labelled as current qualification.

Raw recordings remain local because they contain provider output and opaque provider signatures. The committed reports record local paths; another machine needs its own bounded provider run to reproduce answers. The artefact notes record SHA-256 digests. An offline scripted fixture can instead be seeded in a scratch database:

```bash
DATABASE_URL=… pnpm exec tsx scripts/cv-replay-fixture.mts [recording.jsonl]
```

Then replay it with `pnpm --filter @col/worker cli replay <draft-id> --recordings <file> --out <report-path>`. A scripted report is explicitly unverified and does not satisfy the live release gate.
