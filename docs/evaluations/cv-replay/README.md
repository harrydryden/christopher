# CV replay report

`report.json` is the evaluation report CI holds to the shipped prompt set
(`scripts/check-evaluation-reports.ts`; docs/DEPLOY.md, "Evaluation reports and the prompt set").
It is written by `pnpm --filter @ava/worker cli replay <draft-id> --recordings <file> --out
docs/evaluations/cv-replay/report.json`.

The report committed now is marked `"unverified": true`: it replays a recording of the synthetic
fixture draft (`apps/worker/src/cv-replay-fixture.ts`) made through the scripted client
(`scripts/cv-replay-fixture.mts`), because this environment has no API key. It proves the record →
replay → grade mechanism end to end at the shipped prompt set; its costs are the scripted client's
figures, and no model has graded these prompts in it. Replace it with a report replayed from a live
recording (`pnpm cli record <draft-id>`) before relying on a prompt or route change.

The recording it was replayed from is not committed: recordings are written under
`docs/evaluations/recordings/`, which `.gitignore` excludes. To regenerate it, point `DATABASE_URL`
at a scratch or development database and run

```bash
DATABASE_URL=… pnpm exec tsx scripts/cv-replay-fixture.mts [recording.jsonl]
```

which seeds and publishes the fixture draft through the scripted client, records a rebuild of it,
and prints the draft id and the recording's path; then replay that recording with the `cli replay`
command above.
