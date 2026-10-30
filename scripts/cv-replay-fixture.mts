/**
 * Exercise the record → replay → grade gate without a key.
 *
 *   DATABASE_URL=… pnpm exec tsx scripts/cv-replay-fixture.mts [recording.jsonl]
 *
 * Seeds the synthetic fixture draft (apps/worker/src/cv-replay-fixture.ts) for a fixture account,
 * publishes it through the real handler against the scripted client, then records a rebuild of it
 * through the same scripted client. It prints the draft id and the recording's path, for
 *
 *   pnpm --filter @col/worker cli replay <draft-id> --recordings <recording.jsonl> --out <report.json>
 *
 * The recording says it was made by an injected client, so every report replayed from it is marked
 * `unverified`: the answers are scripted, not the provider's. Point DATABASE_URL at a scratch or
 * development database; it writes one account and one published CV.
 * Set CV_EVAL_TARGETED_FIXTURE=1 to exercise the targeted pause and owned priority confirmation.
 */
import { runMigrations } from "../packages/db/src/migrate";
import { createDeps } from "../apps/worker/src/context";
import { readEnv } from "../apps/worker/src/env";
import { publishReplayFixture } from "../apps/worker/src/cv-replay-fixture";
import { recordCvDraft } from "../apps/worker/src/cv-replay";
import { createScriptedAiClient } from "../apps/web/test/scripted-ai-client";

async function main() {
  const targeted = process.env.CV_EVAL_TARGETED_FIXTURE === "1";
  if (process.env.CV_EVAL_TARGETED_FIXTURE && !targeted)
    throw new Error("CV_EVAL_TARGETED_FIXTURE must be 1 when set.");
  const deps = await createDeps(readEnv());
  try {
    await runMigrations(deps.db);
    const draft = await publishReplayFixture(deps, createScriptedAiClient({ barrierMs: 200, targetedSignpost: targeted }).client,
      targeted ? "cv-targeted-replay-fixture@example.invalid" : "cv-replay-fixture@example.invalid", { targeted });
    deps.aiClient = createScriptedAiClient({ barrierMs: 200, targetedSignpost: targeted }).client;
    const { path, report } = await recordCvDraft(deps, draft.id, process.argv[2] ? { path: process.argv[2] } : {});
    console.log(JSON.stringify({ draftId: draft.id, targeted, recording: path, recordedCalls: report.calls, outcome: report.outcome, passed: report.grade?.passed ?? false }));
  } finally {
    await deps.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
