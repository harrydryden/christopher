# Scoring admission and truthful waiting states — development checkpoint

This checkpoint starts from local commit `b244d5f`. Astra owns the state model and integration; Sol implements worker admission and the interface in separate workstreams. The deterministic repairs are locally verified to the scope below. This is a development checkpoint, not acceptance of the 90-point objective.

## Problem and intended behaviour

A score request previously claimed to be “scoring…” before the worker had checked whether AI existed or the account could afford it. The same label expired after two minutes even when a configured batch was legitimately waiting. Some direct producers did not update the state at all, leaving an old skipped/outside-filter explanation after a person requested work. Duplicate queue calls could also stamp a fresh queued state despite accepting no new work, and task insertion followed by a separate state update could race a fast worker.

The design separates durable intent from worker admission. A bounded request carries the exact account and role identities; mutable display state is not the work ledger. The worker owns availability and budget decisions. Shared database code does not infer the worker's credentials from the web process. Final scoring still rechecks eligibility, affordability and provider admission at execution time.

The interface must describe only known facts: a request awaits checking; admitted work waits for a score; a prior score remains visible with an update label; unavailable, budget-limited and failed outcomes allow role review to continue. A queue timestamp cannot prove that a model is running. Terminal failure must not leave an indefinite pending label. Failure settlement takes the same role lock as a new request, then checks active work in a fresh database statement; a regression holds that lock while a newer request commits, proving the older failure cannot overwrite it.

## Development beyond the initial state repair

Cross-review found that checking only existing `score_job` rows misses work already handed to a provider batch. Final score preparation now compares the current input fingerprint with active batch items: identical work reuses the pending result, while changed inputs remain eligible. The execution-time check also covers a new request queued during batch hand-off, because the original running task and its poll record change ownership atomically. These checks use model stubs in local tests; no paid provider was called.

A blocked full re-score must not be cached as completed. A no-key or budget-blocked pass does not write the completion marker used by input coalescing; a subsequent same-input request may repair unavailable, budget-limited or failed roles without re-queuing the successful roles. The display also distinguishes a completed model attempt that returned no usable score from work that has not started.

The first phone check exposed a real 391px document at a 375px viewport with enlarged text. Full-width Location/Fit card rows, a separate Review row, wrapped tab labels and removal of the decorative bar on narrow cards restore a 375px document while retaining the score and explanation. See [the browser evidence](implementation-evidence/SCORE-UX-BROWSER-CHECK.md). This is scripted computed-font enlargement, not native browser zoom, assistive-technology certification or a human usability session.

## Required verification

| Requirement | Authoritative proof | Result |
|---|---|---|
| No-key worker producers do not create futile per-role score work | Shared admission is used by scan, description, import/adoption, re-evaluation and re-score. Direct no-key assertions cover admission, scan, import and re-score; enabled-AI description fixtures preserve once-only and many-follower queue behaviour. | Focused tests and authenticated browser path pass; full worker result below |
| Web intent is durable and account scoped | Exact bounded request payloads; repeated IDs survive view changes; automatic and explicit requests have distinct intent keys; account-scoped polling; bulk actions and Undo record the exact requested roles | Admission tests and 77 action tests pass; full web result below |
| Admission is truthful and race-safe | Separate account limits, a live CV hold, repeated refusal, hold expiry, unchanged-score protection and priority promotion; insertion and display-state writes share a transaction | Focused admission/learning tests pass |
| Batch waits stay understandable | Neutral waiting copy has no two-minute inferred phase. Matching active-batch fingerprints cause no second model call; changed fingerprints remain eligible. Polling includes account-owned batch work. | Local fixture/formatter tests pass; no live provider batch qualified |
| Terminal failure settles safely | Orphaned admission/score work becomes failed; active follow-ups and batch work are protected; a held-lock concurrency regression proves fresh follow-up visibility | Focused regression passes; no hosted crash claim |
| User can keep reviewing | Prior fit value remains visible; one formatter serves table/review/CSV; phone layout passes at 375px normal and scripted doubled text | Fixture layout and authenticated request/automatic refresh/CSV path pass |
| Integration and rollout | Full/focused local suites, all five package typechecks, worker bundle and web production build; consumer-before-producer rollout documented | Local builds/typechecks pass; exact hosted release remains unqualified |

## Integrated verification

- Core: **708/708**, 42 files. The first run was 707/708 because the task enumeration assertion still expected 23 rather than 24 types; the corrected complete run passed.
- Database: **98/98**, 10 files.
- Release harness: **121/121**, no skips. This validates the harness, not a paid-model replay or hosted release.
- Worker: complete frozen production-code run **728 passed, 1 failed of 729**, 56 files. The sole failure was the import retry fixture setting an immediately due task from JavaScript wall time while claiming compares PostgreSQL time. No task was claimed. The test now sets `run_after` with PostgreSQL `now()`; the complete import suite then passed **14/14**. Exact clock skew was not measured. No production code changed after the full run. This is not relabelled as a later 729/729 full run.
- Web: **1,240/1,240**, 138 files. The earlier diagnostic run had 1,237 passes and three old queue-contract assertions failing; exact bounded intent and fixture-key normalisation replaced those assertions, and both affected files passed 77/77 before the final run. The formatter's last copy change also landed during that diagnostic run; only the final frozen run is the integration gate.
- TypeScript: all **five** workspace packages pass. Worker bundle passes. Next.js production build passes, build ID **`Ga8rtPUzagoURQYKOZDHl`**.
- Authenticated local browser: Shortlist → exact durable request → one claimed real admission handler with ownership fencing → completion, no key and zero provider calls. The open page changed to unavailable without navigation/reload in **9.0 seconds**; authenticated CSV returned 200 with matching wording. This used a bounded handler harness, not a long-running worker daemon or scheduler. The dev server was stopped afterwards.

The [independent review](SCORE-ADMISSION-INDEPENDENT-REVIEW.md) records the batch defect and its resolution. The [evidence manifest](implementation-evidence/score-admission-verification.json) binds retained logs, scripts and source files to their hashes. AI-enabled tests use injected stubs; they do not measure provider quality, billing, real batch latency or delivery.

## Rollout

`admit_scores` is a new queue protocol, although its task type and two view states use existing text columns. Every queue consumer, including the serverless fallback, must understand it before the new producer is enabled. Old workers must not be allowed to consume unknown admission tasks. Stop the producer and drain its requests with compatible consumers before rolling those consumers back. [The deployment guide](../../DEPLOY.md) records this protocol-specific sequencing and its interaction with existing CV lifecycle rollout order. Hosted rollout is unverified. There is also a remaining historical-state repair: the new abandonment hooks settle future failures, but they do not replay already-failed tasks from an older release. An old `queued` view with no active task can therefore still show waiting. Before rollout, add bounded reconciliation of such orphaned states, preserving current admission, score and provider-batch work under the same row-lock rules. This case was identified by code review; it is not presented as repaired by this checkpoint.

## Separate source finding

The [second bounded Siemens continuation](implementation-evidence/source-audit/SIEMENS-LEASE-AND-DRIFT.md) staged 296 fresh pages and 1,774 distinct URLs after genuine offset drift caused a restart. It still had a Next link and published no jobs. The audit's shortened last claim caused an avoidable cancellation; the diagnostic harness now refuses to start without a full three-minute claim allowance. The production page, byte and age limits remain unchanged. Neither this harness repair nor the partial checkpoint establishes recall or source completeness. Positive-only publication of verified partial results remains development work, with absence-based closure reserved for a complete observation.

## Limits and re-score

This change can repair deterministic state and queue correctness. It cannot establish model scoring quality, genuine learning calibration, unaided task success or hosted operating reliability. Those existing JTBD gates remain open. Independent review recommends no score increase, and Astra retains all nine values: **J1 83, J2 77, J3 85, J4 83, J5 85, J6 85, J7 80, J8 83, J9 70**. No job is certified at 90. The [scorecard and ordered roadmap](RESCORE-90.md) retain the original formula and dimension floors. Immediate engineering work remains for historical orphaned score states and useful, safely published partial source results; model, user and hosted acceptance gates remain open.
