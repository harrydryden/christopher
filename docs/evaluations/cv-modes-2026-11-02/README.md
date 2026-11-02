# CV editing modes qualification — 2 November 2026

Synthetic data only: the candidate, employers and role are invented.

The real worker rebuilt the Refine fixture with a saved writing instruction and ranked targeting choices through the provider, then replayed the recorded responses offline. Both runs passed factual support, page limit, coverage and essential-requirement checks. The printed PDF was visually inspected for clipping and layout defects.

- Prompt set: `f21a62396b80`; author/improvement version: `db10cb442f`.
- CV: four provider calls, $0.728887. Skills: two calls, $0.135528, ten suggestions in five categories.
- Existing cumulative guarded evaluation ledger: $5.709337 against the authorised $10 cap. No production data or production database was used.
- `report.json` is the live qualification; `replay.json` is the exact offline recording replay. Raw provider recordings remain local and are not committed.
- The fixture uses an existing confirmed evidence map and role rubric. This is qualification of generation/refinement, fitting, assessment and suggestions; action-level concurrency, free saves, ownership, reset and migration proofs are separate tests described in ADR 0005.

Reproduction uses `scripts/run-live-release-evaluation.mts` with `CV_EVAL_EDITING_MODE=refine`, the targeted/ranked fixture flags and the retained cumulative budget ledger. Scripted mode-aware record/replay tests need no provider key.
