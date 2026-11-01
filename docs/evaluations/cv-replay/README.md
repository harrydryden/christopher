# CV replay report

`report.json` is the current verified report checked against the shipped prompt set by `scripts/check-evaluation-reports.ts`. It qualifies **`839f32787cdd`** using fresh provider responses for the ranked, targeted synthetic fixture. All ten printed claims are supported, all three essentials are demonstrated, all four replay invariants pass and no recorded requests are missing.

The changed author/improvement instruction uses a measured font-aware capacity allowance. The live fixture's smaller evidence library remains one page within its two-page maximum; rich deterministic fixtures separately verify improved use of two pages. The qualified production-display PDF, content and scope/cost notes are in `../cv-capacity-2026-11-01/`.

Three live CV calls cost $0.612663 and two live skill calls cost $0.137558. The skill probe produced ten verified suggestions across three categories. The existing cumulative $10 ledger settled at $4.844924, including previous evaluations; it was not reset. The rubric and initial plan remain cached synthetic inputs, not newly live-qualified extraction stages. Offline replay time is not provider latency. No customer data or production database was used.

## Historical evidence

- `report-live-2026-10-31-ranked.json` preserves the previous current replay at prompt set `31014dbb8d9a`; its live qualification and skills are in `../cv-ranked-2026-10-31/`.

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
