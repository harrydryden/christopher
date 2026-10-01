# Learning history evidence — 2 October 2026

[Checkpoint](../../LEARNING-HISTORY-VERIFICATION.md) · [Independent review](INDEPENDENT-REVIEW.md)

- `fixture.json` and `seed-browser.ts`: isolated synthetic accounts, 26 standing decisions and profiles 1/3; foreign profile 2. Never genuine calibration evidence.
- `dirty-older-navigation.txt`: actual Next Link navigation keeps dirty profile/pin values and page-1 tag guard while page 2 exposes older decisions.
- `older-save-db.txt`: decision 21's selected tags persisted.
- `comparison-keyboard-drafts.txt`, `comparison-phone.png`: Enter opens native comparison, content identifies three kinds of change, profile guard and drafts retained; inspected 375px capture.
- `historical-tab.txt`, `original-tab-drafts.txt`: historical profile opens separately; original editor values remain.
- `pending-newer-navigation.txt`, `pending-newer-settled.txt`: save remains pending on page 2 after Newer click while the account advisory lock is held.
- `pending-save-released.txt`, `pending-save-db.txt`: 30-second database statement timeout rolls back; queued navigation reaches page 1 with retained choices and uncertainty alert. No database change.
- `retained-retry-success.txt`, `retained-retry-db.txt`: retry after release commits tags, removes the off-page clean row and focuses the named confirmation. Viewport and document both 375px.
- `unavailable-version-page-clamp.txt`: unavailable owned version reveals neither foreign profile nor editable profile form; numerically unsafe page input safely falls back to page 1.
- `tag-focused-tests.txt`: 8 focused tests, exit 0.
- `full-web-tests.txt`: 154 files / 1,379 tests, exit 0.
- `web-typecheck.txt`, `web-build.txt`: final verification commands and exits.

Comparison focused logs remain alongside the prior checkpoint under `../learning-completion/profile-comparison-*.txt`. Counts overlap the full suite.

Browser commands used `npx --yes agent-browser --session learning-history` at `http://127.0.0.1:3152/learning`, with isolated `ava_learning_history_ui_1002`, serverless fallback disabled and no provider key. A separate database was used for automated tests. `BEGIN; SELECT pg_advisory_xact_lock(874302,hashtext(id::text)) FROM users WHERE email='history@example.test';` held the synthetic account fence; `COMMIT` released it. The existing 30-second statement timeout caused the observed refusal; this was not a successful pending-save replay. The attempted extra checkbox change during that wait used an unsupported selector and did not occur; no claim relies on it. An initial incorrect browser tab-switch command was corrected with `tab t1` before recording the original-tab values.

Browser sessions and dev server were closed, the synthetic cookie removed, and the lock transaction ended. Text log trailing whitespace is normalised without changing reported outcomes.
