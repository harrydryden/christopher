# Score recovery verification — 1 October 2026

The all-JTBD 90/100 objective remains open. This checkpoint closes the historical orphan-score gap identified in the [previous scoring checkpoint](../2026-09-29/SCORE-ADMISSION-VERIFICATION.md), and adds recovery directly to the role review. Astra handled orchestration, concurrency decisions and integration; Sol implemented and cross-reviewed the worker and interface changes.

## Resulting behaviour

- Hourly maintenance changes an old `requested` or `queued` view to `failed` only when no active admission, score or provider-batch task owns that exact account and role. It preserves previous scores and creates no AI work. It processes at most 200 candidates per transaction, skips locked views, checks ownership again after locking at READ COMMITTED, and applies statement, lock and run time limits. Null legacy timestamps qualify; stamped rows have a ten-minute grace. Active work stays protected regardless of age.
- Batch abandonment can commit a failed poll task before its fallback hook runs. If maintenance repairs the view in that interval, the hook now restores eligible waiting/failed views to `queued` atomically with fallback tasks. A newer successful score or explicit request is preserved. The shared queue helper locks role views before task changes, matching recovery; the ordinary admission caller already held those locks, so this is an exported-helper guarantee rather than proof that ordinary admission previously deadlocked.
- A failed role has **Retry score** in its review panel. The action authenticates a verified account, locks its own view, rechecks eligibility and records one exact explicit admission request. Repeated pending requests are harmless, another account's view is inaccessible, and a stale failed panel cannot replace a successful score. The previous score and manual review decisions remain available. Browser use exposed an acknowledgement lost during revalidation: the control now stays mounted through requested/queued states with a disabled **Score requested** button and an accessible status message, and becomes retryable again on failure.
- Migration **0049** adds a partial index for waiting score views. It is additive, but its normal transactional index build may briefly block writes on a large hosted table. [Deployment instructions](../../DEPLOY.md) retain the compatible-consumer-before-producer protocol and explain the bounded hourly repair.

## Verification

The retained evidence is in [score-recovery](../2026-09-29/implementation-evidence/score-recovery). No production deployment, external notification or paid provider call was performed.

| Check | Result and scope |
|---|---|
| Original full worker run | **711 passed, 11 failed, 18 skipped / 740**. Retained unchanged. Failures included long query stalls, timeouts and fixture-truncation deadlocks. The browser suite was explicitly disabled for this run. Interruption is a possible explanation, not a proved root cause. |
| Isolated end-to-end rerun | **105/105 passed**, including every previously failed case, without changing tests or production code. |
| Fresh full worker run | **740/740 passed, 57/57 files**, browser enabled, no skips, 458.91 seconds. No worker/test edits were needed after the failed run. |
| Database suite | **98/98 passed** with migration 0049 and the queue helper changes. |
| Focused orphan/admission/maintenance | **30/30 passed**; independent orphan review separately ran **6/6**. |
| Full web suite | **1,249 passed, 1 failed / 1,250** across 139 files. The sole failure correctly identified the new retry action missing from the explicit authentication inventory. The application code is unchanged after this run; the test inventory now classifies it as verified-account-only. The entire authentication file then passed **160/160**, including anonymous and unverified access checks for the new endpoint. The original full run is not relabelled as a clean run. |
| Authenticated browser recovery | Keyboard Enter requested exactly one admission; the real one-shot worker, with AI disabled, settled it to unavailable. Score 72, rationale and shortlist decision were retained. The panel refreshed in 8.1 seconds without navigation. No page errors or external requests. At 375px, normal and exactly doubled computed text stayed within 375px; the button font measured 13→26px. This is text enlargement, not native browser zoom or a human usability trial. |
| Workspace typechecks | All five packages passed; the interface passed again after the browser-driven repair. |
| Production builds | Worker bundle and Next production build passed; web build ID `ME_9axPZfATYgmYkIUYey`. |

The [independent worker review](../2026-09-29/SCORE-RECOVERY-INDEPENDENT-REVIEW.md) covers the orphan implementation. A separate Sol reviewer examined the batch hand-back change and its forced-order tests. The React review checked stable row identity, unconditional hooks with primitive dependencies, authenticated server action, no nested button and accessible pending/error feedback. These are local correctness checks, not hosted recovery, representative user success or model-quality qualification. The browser harness reports one historical score task for the fixture; a separate database inspection confirmed it was already done, with no active score task. The admission itself queued zero model tasks and AI-call count remained zero.

## Re-score and remaining development

No numerical increase is justified by this bounded recovery change. The score formula remains `20 × (0.30 completeness + 0.30 robustness + 0.40 UX/UI)`. Current scores are **J1 83, J2 77, J3 85, J4 83, J5 85, J6 85, J7 80, J8 83, J9 70**. Every job remains below 90; J2, J7 and J9 also miss at least one dimension floor. The complete dimension scores and acceptance requirements remain in [RESCORE-90](../2026-09-29/RESCORE-90.md).

Next is [safe publication during continued source scans](../2026-09-29/PARTIAL-SOURCE-PUBLICATION-PLAN.md): make verified matching roles useful before a long listing finishes, with durable publication progress, first-scan semantics and protection against older pages overriding newer observations. That document is a development design, not implemented functionality. Provider-quality replay, independent posting labels, representative usability/calibration, and authorised hosted release/restore evidence remain separate qualification requirements.
