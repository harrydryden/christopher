# CV replay report

`report-live-2026-11-02.json` preserves the verified report for **`f21a62396b80`** byte-for-byte. Its active `report.json` copy is now marked unverified for the current registry because new scoped editing prompts have not received live qualification. The historical run used fresh provider responses for a Refine edition with a writing instruction and ranked, targeted synthetic choices; all four replay invariants passed with no missing recorded requests. See `../cv-inline-edit-2026-11-11/` for explicitly unverified current fixture evidence and the remaining release gate.

The worker preserves the editing mode, frozen source, stable targets, role choices and pinned routes through the isolated replay rather than converting the fixture to a legacy build. The live result, exact PDF and scope notes are in `../cv-modes-2026-11-02/`.

Four live CV calls cost $0.728887; two skill calls cost $0.135528 and produced ten suggestions across five categories. The existing cumulative $10 ledger settled at $5.709337; it was not reset. The rubric and initial evidence map remain cached synthetic inputs, not newly live-qualified extraction stages. Offline replay time is not provider latency. No customer data or production database was used.

## Historical evidence

- `report-live-2026-11-01-capacity.json` preserves the previous qualification at `839f32787cdd`; its live artefacts remain in `../cv-capacity-2026-11-01/`.

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
