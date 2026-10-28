# CV replay report

`report.json` is the evaluation report CI holds to the shipped prompt set
(`scripts/check-evaluation-reports.ts`; docs/DEPLOY.md, "Evaluation reports and the prompt set").
It is written by `pnpm --filter @col/worker cli replay <draft-id> --recordings <file> --out
docs/evaluations/cv-replay/report.json`.

The current `report.json` replays a genuine provider recording of the synthetic fixture at prompt
set `987e0b5ac958`. It published a CV with supported claims inside its page limit, passed all four
replay invariants and had no missing recorded calls. A prior verified provider replay remains in
`report-live-2026-10-28.json` for its original prompt set.

That earlier recorded build published
with supported claims inside the page limit. Its comparison with the older scripted draft baseline
failed one essential requirement: the live reviewer marked regulated-environment experience partial
where the scripted fixture had marked it fully met. That comparison is retained separately in
`failed-scripted-comparison.json`; it is not hidden or treated as a passing qualification.
The earlier offline replay compared the rebuilt CV with the live recording's own assessment and
passed all four invariants at that prompt set. The new skill stages were called live on the saved
synthetic fixture with current Write context; their successful bounded, grounded summary is in
`../cv-skill-live-probe.json`. The first verifier call exhausted its 1,200-token ceiling, accepted
no suggestions and is retained in `../cv-skill-live-probe-failed-2026-10-28.json`. After the ceiling
and budget reservation were corrected, a second two-call skill probe passed using the **same $10
attempt ledger**. The CV recording and the skill probe use the same invented candidate and role;
the skill probe tailors from the saved fixture CV, while the provider CV replay runs in a rollback
scratch transaction. The replay report alone does not exercise skill stages.
The earlier bounded live continuation reused one existing genuine provider author response after
an exact prompt/version/input match and made two fresh provider review calls. Its replay report's
cost includes the reused author call; it is not the incremental amount charged in that continuation.

The raw provider recording is not committed: recordings contain synthetic candidate text and
provider output, and are kept in ignored local evidence. The committed report records its local
path and the prompt set; another machine needs its own provider run to reproduce the answers.
For an offline scripted fixture when provider access is unavailable, point `DATABASE_URL` at a
scratch or development database and run

```bash
DATABASE_URL=… pnpm exec tsx scripts/cv-replay-fixture.mts [recording.jsonl]
```

which seeds and publishes the fixture draft through the scripted client, records a rebuild of it,
and prints the draft id and the recording's path; then replay that recording with the `cli replay`
command above.
