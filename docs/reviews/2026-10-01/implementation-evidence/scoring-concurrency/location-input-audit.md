# A5 location input evidence — 1 October 2026

Scope: `packages/ai/src/score-location-evidence.ts`, A5 rendering and prompt in `engine.ts`/`prompts.ts`, their focused tests, and the worker's `score-location.test.ts`. The canonical worker input remains complete; only the model-facing location evidence is bounded to 12 KiB UTF-8 after job-fence escaping.

Validation used local fake model clients and repository pricing metadata. No provider generation call was made. See [mock request sizes and estimated reservations](../../../../benchmarks/a5-location-budget-2026-10-01.json); these are byte/3 token proxies and repository-priced reservations, not provider token counts or charges.

- `ai-location-regression.txt`: `pnpm --filter @ava/ai exec vitest run src/engine.test.ts src/batch.test.ts src/score-location-evidence.test.ts src/prompt-registry.test.ts` — 4 files, 136 tests passed.
- `ai-location-typecheck.txt`: `pnpm --filter @ava/ai typecheck` — passed.
- `worker-location-regression.txt`: `pnpm --filter @ava/worker exec vitest run src/score-location.test.ts` — 3 tests passed.

The A5 prompt text changed; the registry derives a new prompt version from its text and output schema. Tests confirm live and batch requests use identical location evidence and honour a pinned route even when the engine reports a stale route.
