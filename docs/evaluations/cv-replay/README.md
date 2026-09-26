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
