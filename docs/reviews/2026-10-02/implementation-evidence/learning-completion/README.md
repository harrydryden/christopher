# Evidence: starting preferences and retained tag drafts

2 October 2026, Europe/London. The fixture is entirely synthetic. It ran against isolated database `ava_learning_completion_ui_1002` on local PostgreSQL at `127.0.0.1:55439`, with Next at `127.0.0.1:3150`, `AVA_SERVERLESS_FALLBACK=0`, an empty provider key and no worker. `seed-browser.ts` is the reproducible initial fixture. The temporary synthetic cookie was removed and both the browser session and web server were closed after verification. The database and shared container were retained.

## Browser evidence

Commands used `npx --yes agent-browser --session learning-completion`, restricted to `127.0.0.1`. Controls were scrolled into view before interaction. Reads were taken after server actions settled, and claimed saved values were checked in PostgreSQL. Phone checks use a 375×812 desktop Chromium viewport rather than a physical phone.

| Check | Authoritative observation |
|---|---|
| Settings save defeats stale Learning draft | `settings-seed-saved-db.txt` records the Settings save. After a profile save refreshed Learning, `learning-seed-conflict.json` shows the older expected text, intact local draft and inline conflict; `learning-conflict-db.txt` retains the Settings value. |
| Learning save defeats stale Settings draft | After Learning saved a newer value, a Table setting save refreshed Settings. `settings-seed-conflict.json` retains its draft and original expected text with a conflict; `settings-conflict-db.txt` retains the Learning value. |
| Pristine Settings refresh | `settings-pristine-refresh.json` shows the newer Learning value in both the visible textarea and expected-value input after saving the unrelated Table form. |
| Unchanged save | `seed-noop-browser.json` shows Saved and matching text/guard. `seed-noop-before.txt` and `seed-noop-after.txt` compare byte-identically with `cmp` (exit 0), including the stored seed timestamp and all queued task fields. |
| Dirty row falls to 21st | Twenty newer synthetic decisions were inserted after checking culture on Operations Lead. A profile save refreshed Learning. `tag-row-retained.json` records 21 editors, culture/leadership preserved and the original guard. The screenshot `tag-retained-phone.png` shows the explanation and discard control. |
| Stale retained save | A later fixture row, Synthetic newer role 1, was edited and displaced. Its stored tags were then set to remote in PostgreSQL to simulate a newer edit. `retained-tag-conflict.json` records the original empty-tag guard, retained culture selection and inline conflict. The final DB read retains remote. This is a controlled database interleaving, not a second human participant. |
| Explicit discard | `retained-tag-discard.json` records the original displaced row removed and the list returned to 20 editors. The later refused Synthetic newer role 1 draft was also explicitly discarded. |
| Confirmed retained save | Synthetic newer role 2 was edited, displaced by another inserted fixture, then saved through its own form. `retained-tag-saved.json` records 20 editors, no retained row, and focus on the named status. `retained-tag-final-db.txt` confirms its culture tag and the prior row's remote tag. |
| Phone presentation | Recorded widths remain 375. `seed-conflict-phone.png`, `tag-retained-phone.png` and `tag-saved-phone.png` were visually inspected; fields, checkboxes, recovery, discard and save controls fit the viewport. |

The additional decisions solely move rows through the 20-item boundary. They are not genuine calibration evidence, regardless of the calibration panel's fixture count. Pending responses and pristine in-flight list removal are covered by React component tests, not a separate network-delay browser experiment in this checkpoint.

## Automated checks

`seed-verification-commands.txt` and `seed-final-tests.txt` record 205 passing tests across five suites, including 180 authentication-classification checks, the seed action/settings/verification paths and three controlled-seed editor tests. The concurrent test holds the account fence on one connection, observes two callers waiting on it, then releases it and verifies exactly one save and one conflict.

`reason-tags-component-tests.txt` records four passing list-retention tests. `editor-regression-tests.txt` records 22 passing tests in the final combined regression run for the shared form and all Learning editors. Three seed cases overlap the 205-test batch, so these two final runs cover 224 distinct tests; the separate four-test list run is also an overlap. Typecheck logs are `seed-web-typecheck.txt` and `reason-tags-typecheck.txt`. `web-build-final.txt` records the passing final production build. Text-log trailing whitespace and terminal progress carriage returns are normalised without changing diagnostic content or exit codes.

## Failed or incomplete diagnostic attempts

The first retained-row click selector also matched the ancestor Card section and therefore saved its first row. `incomplete-retained-conflict-replay.json`, `incomplete-retained-save-replay.json` and `incomplete-retained-save-phone.png` are not passes. The latter JSON abbreviates body focus text to avoid storing a full development RSC script dump. Final selectors require `section:has(>h3)` as well as the retained row's uniquely named discard button. The final conflict and success files establish the intended row and database outcome.

An initial no-op database query named a non-existent task timestamp column; it was corrected to capture `to_jsonb(tasks)`, then the no-op save and comparison were rerun. No conclusion uses that failed query.

No paid model, hosted mutation, deployment, notification or real-user acceptance run occurred. These checks establish bounded local correctness and recovery, not the full JTBD readiness threshold.
