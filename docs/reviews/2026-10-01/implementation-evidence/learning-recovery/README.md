# Learning recovery evidence

Local work began on 1 October and final verification continued after midnight on 2 October 2026 (Europe/London). All browser data is synthetic. Astra performed the browser diagnosis and final replay; Sol implemented and independently reviewed the repair.

## Environment and method

`seed-browser.ts` creates only `ava_learning_recovery_ui_1001` on the shared local PostgreSQL instance at `127.0.0.1:55439`. Next ran at `http://127.0.0.1:3149`, with `AVA_SERVERLESS_FALLBACK=0`, an empty provider key and no worker. The synthetic session cookie was stored in a mode-600 temporary file, then removed. The browser session and Next server were closed after verification. The shared container and isolated databases remain available.

Browser commands used `npx --yes agent-browser --session learning-recovery`, restricted to `127.0.0.1`. Separate tabs represented concurrent edits by the same synthetic account. Final pointer actions explicitly scrolled controls into view before filling or clicking them. Every claimed committed profile/tag change was checked in PostgreSQL after the action settled; an immediate read can precede a server action's completion. DOM reads captured visible text, selected tags, hidden comparison values, alerts and viewport width. Phone checks used a 375-pixel viewport; these are desktop Chromium emulation, not physical-phone or assistive-technology qualification.

## Final browser observations

| Check | Evidence and result |
|---|---|
| Dirty profile, pins and answer survive sibling refresh | `final-dirty-editors-refused.json`: all three drafts remain, all three submissions return inline conflicts, with guards 8/6/6. `final-dirty-editors-db.txt`: the independently saved profile remains version 9; no stale append occurred. |
| Comparison in another tab | Clicking the profile recovery link opened tab t3 at `/learning`; t1 kept its profile, pinned and answer drafts. The later `final-remote-answer-retained.json` still shows the original draft. |
| Remote answer does not unmount a draft | Tab t2 answered the question, creating version 10. After t1 saved starting preferences to refresh the page, `final-remote-answer-retained.json` shows its unsaved answer beside the newer saved answer. |
| Pristine text and guards refresh together | `final-pristine-refresh.json` records updated pins at version 10. `final-pristine-new-text.json` records the genuinely changed profile text at version 11, both guards 11 and the version chooser 11. |
| Consecutive ordinary saves work | `final-profile-success.json` and `final-consecutive-success.json` show a profile save followed by a pin save without conflicts. `final-consecutive-success-db.txt` confirms versions 12/13 and the submitted text. |
| Pristine tag refresh and consecutive saves | `final-tags-pristine.json` shows leadership/remote and their matching new guard. `final-tags-first-save.json` shows culture/leadership/remote after save; `final-tags-second-save.json` keeps culture/remote after the next save, without reverting. |
| Dirty tags refuse a stale save | `final-tags-conflict.json` retains culture/leadership and its original guard after sibling refresh; `final-tags-db.txt` confirms the newer culture/remote selection remains stored. |
| Offline header action preserves other work | `final-offline-header.json` records the uncertain-outcome message, while profile, pins and answer drafts remain intact. Offline mode was then disabled. |
| Validation preserves an overlong answer | `final-answer-validation.json` records the specific 2,000-character limit message and all 2,001 entered characters retained. |
| Phone layout | Recorded 375-pixel states have document width 375. `final-conflict-phone.png` and `final-tags-phone.png` were visually inspected: labelled checkboxes, recovery links and save/discard controls remain within the viewport. |

Changes during a pending response, explicit discard and question removal are covered by component tests; this final browser replay does not independently exercise every such branch. The earlier shared-form checkpoint separately records a delayed and lost-response browser experiment.

## Automated checks

Captured text logs have trailing whitespace and terminal progress carriage returns normalised; diagnostic content and exit codes are unchanged.

`verification-commands.txt` records exact commands and exit codes for 107 tests across six sequential web suites, web typecheck and database typecheck. `web-learning-final.txt` includes profile/tag failure-injection rollback and missing/stale guard tests, general action/verification coverage and controlled-editor regressions. `README-queue.md` links the 16 database queue tests, 13 scheduler tests, database/worker typechecks and worker build. `web-build-final.txt` records the final production web build and its exit code.

The [independent review](INDEPENDENT-REVIEW.md) includes the React 19 reproductions which invalidated earlier approaches. It retains J7 at 80 and J8 at 83.

## Superseded and failed evidence

`sibling-refresh-before-repair.json` and `sibling-refresh-overwrite-before.txt` prove the old draft silently overwrote version 4 as version 5. `profile-conflict.json` and `profile-conflict-mobile.png` only establish an earlier narrow stale-submit case. `first-candidate-guard-refresh.json` is an intermediate refresh observation, not a passing final check.

The `sibling-refresh-after-repair-*` files prove the first-edit-only candidate refused a dirty version-5 draft against version 6, but that candidate remained unsafe for pristine uncontrolled textareas and was superseded. The final implementation uses controlled value/version pairs.

`incomplete-pointer-replay.json` and its database read are not a concurrency pass: offscreen focus did not activate the intended second-tab control. The final replay explicitly scrolled controls into view and verified the second-tab commit before submitting stale drafts.

## Limits

Starting preferences remains uncontrolled and unversioned: pristine text can lag refreshed defaults, and concurrent edits remain last-write-wins. A dirty tag editor can be unmounted when its decision leaves the 20-row recent list. No draft survives a closed/reloaded page through a new persistent store. Tag comparison uses current values and `tagsEdited`, not a new monotonic revision, so it does not detect an intervening change restored to identical values.

No paid provider call, genuine calibration decision, production deployment, hosted mutation or external notification occurred. Neither these checks nor the synthetic `sourceDecisionCount` qualify model quality, real user task success or operational readiness.
