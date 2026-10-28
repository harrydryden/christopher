# CV replay report

`report.json` is the evaluation report CI holds to the shipped prompt set
(`scripts/check-evaluation-reports.ts`; docs/DEPLOY.md, "Evaluation reports and the prompt set").
It is written by `pnpm --filter @col/worker cli replay <draft-id> --recordings <file> --out
docs/evaluations/cv-replay/report.json`.

The committed report now replays a real provider recording of the synthetic fixture draft
(`apps/worker/src/cv-replay-fixture.ts`) at the shipped prompt set. The recorded build published
with supported claims inside the page limit. Its comparison with the older scripted draft baseline
failed one essential requirement: the live reviewer marked regulated-environment experience partial
where the scripted fixture had marked it fully met. That comparison is retained separately in
`failed-scripted-comparison.json`; it is not hidden or treated as a passing qualification.
The ordinary offline replay compares the rebuilt CV with the live recording's own assessment,
passes all four invariants and is the verified release report. The two new skill stages were also
called live on the same disposable local fixture; their bounded, grounded summary is in
`../cv-skill-live-probe.json`. The CV replay gate does not itself exercise those skill stages.
The bounded live continuation reused one existing genuine provider author response after an
exact prompt/version/input match and made two fresh provider review calls. The replay report's
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
