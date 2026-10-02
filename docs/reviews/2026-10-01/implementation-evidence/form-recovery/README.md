# Form failure and response-loss verification — 1 October 2026

Astra reproduced the failures and checked the repaired application with agent-browser 0.27.0. Sol implemented the shared form change and a separate Sol reviewer checked its contract. This is local scripted evidence, not a representative usability study.

## Environment and method

The [fixture script](seed-browser.ts) creates only `ava_form_recovery_ui_1001` on the existing local PostgreSQL service at `127.0.0.1:55439`. It creates a synthetic, unconfirmed member and a short-lived session. Run it with `pnpm exec tsx docs/reviews/2026-10-01/implementation-evidence/form-recovery/seed-browser.ts`. The cookie is written to a mode-0600 temporary file and was deleted after verification. The explicit synthetic session secret is not a production credential.

The real Next development server ran at `http://127.0.0.1:3148` with that database, `SESSION_SECRET=synthetic-form-recovery-browser-secret-2026`, `AVA_SERVERLESS_FALLBACK=0` and an empty `ANTHROPIC_API_KEY`. No worker ran. The browser was restricted to `127.0.0.1`. Browser observations in the JSON files retain agent-browser's JSON-encoded-string output. The ordinary page loaded with expected navigation and controls before fault injection. Baseline screenshots were inspected, as were the final phone recovery screenshots.

## Before and after

| Scenario | Before | Verified repaired behaviour |
| --- | --- | --- |
| First preference save with no include keyword; exclusions `interns`, location `Edinburgh`, remote unticked | The returned validation error erased exclusions/location and reticked remote. [Baseline](baseline-validation.json), [image](baseline-validation.png). | Values and unticked checkbox remain; the error receives focus. [Result](fixed-validation.json). |
| Save starting preferences while the browser is offline | Main content became “Something went wrong”; the textarea disappeared. [Baseline](baseline-offline.json), [image](baseline-offline.png). | The form remains, text is retained, uncertainty is inline and focused; at 375 pixels there is no horizontal overflow. [Result](fixed-offline.json), [initial repaired image](fixed-offline-mobile.png). |
| Restore connection and save by keyboard | — | Focused textarea → Tab → Enter persisted the exact value and showed Saved. [Browser](fixed-offline-retry.json), [database](database-after-retry.txt). |
| Correct the missing keyword and save filters | — | Submitted values survive revalidation and are stored. The first-use card is replaced by separate preference cards. [Browser](fixed-success.json), [database](database-after-retry.txt). |
| Lose the response after the server completes | — | One request reached the server and committed; the page reports uncertainty rather than claiming failure or success, keeps the input, and does not retry. [Browser](lost-response-browser.json), [database](lost-response-database.txt). |
| Check saved state after response loss | — | The recovery link, focused and activated with Enter, opens the saved page in a new tab. Newer unsaved text remains in the original tab. [Saved tab](new-tab-saved.json), [original tab](original-tab-preserved.json), [phone image](lost-response-recovery-mobile.png). |
| Edit while an earlier successful response is held | — | After releasing the response, the newer text remains and no Saved acknowledgement is shown for it. The database contains only the submitted snapshot. [Browser](pending-edit-browser.json), [database](pending-edit-database.txt). |

The [first candidate result](first-candidate-validation-failed.json) is retained as a failed intermediate check. React's synthetic `onReset` did not stop the commit-time native reset; the final repair uses a native reset listener. The initial repaired offline and lost-response screenshots predate the final enlargement of the recovery link. The [final phone image](final-recovery-mobile.png) and [offline measurement](final-offline-mobile.json) show its separate 44-pixel target and unchanged input retention.

Response loss was injected only in the local browser: a one-shot `window.fetch` wrapper selected the `Next-Action` request, awaited the real response and its cloned body, restored the original fetch, then threw a synthetic `TypeError`. The server therefore completed before the simulated loss. A separate wrapper awaited a manually released promise after the real response; text was edited while the form reported busy, then the response was released. Neither injection changed the production implementation. The retained database read reports zero tasks and zero AI calls. This proves these specific client recovery behaviours; it does not prove universal exactly-once mutation semantics.

The first inline recovery link wrapped into disjoint fragments; pointer attempts did not fire its native click listener, though keyboard focus/Enter worked. During diagnosis an explicit same-page href was tried, then the original empty href was restored and keyboard activation independently opened a third tab; `new-tab-saved.json` is from that native-href check. The final link has a separate 44-pixel-high target. A fresh local browser run at 375 pixels, with the unmodified empty href, verified a pointer click opening a [saved-work tab](final-pointer-new-tab.json), while the [original tab](final-pointer-original-tab.json) retained its offline draft. The fixture script reset the synthetic starting preferences before this final run, which explains the different saved text.

Expected browser diagnostics occurred for the deliberately broken baseline and injected fetch failures. The fixed form logs a safe error type/fingerprint, rather than raw request or stored content. There was no full-page error after the repaired failures. The browser was closed, the dev server exited 0, and the synthetic cookie file was removed; the isolated database remains for inspection.

## Regression checks

| Command | Result | Evidence |
| --- | --- | --- |
| `pnpm --filter @ava/web exec vitest run components/SettingsForm.test.tsx components/ApplicationsTable.test.tsx components/CvDraftEditor.test.tsx` | 15/15 across three files, including seven new form tests | [focused-tests.log](focused-tests.log) |
| `pnpm --filter @ava/web exec vitest run components/SettingsForm.test.tsx` after the final announcement-spacing adjustment | 7/7; asserts the alert separates its message and link | [final-copy-tests.log](final-copy-tests.log) |
| `pnpm --filter @ava/web typecheck` | Passed | [typecheck.log](typecheck.log) |
| `pnpm --filter @ava/web build` | Passed after the dev server stopped | [build.log](build.log) |

The form tests include externally associated CV fields, native external rebuild intent, duplicate submissions while pending, navigation-signal passthrough, failure retention and successful reset behaviour. The other component tests exercise existing Applications and CV editor behaviour. Counts overlap: seven is part of 15. The final source-only adjustment after the production build and browser checks adds a literal space between the alert message and link for its spoken announcement; the seven form tests were rerun after that change. No layout or submission logic changed.

No production deployment, paid model call, email or hosted configuration change was made. Unsaved values are retained in the mounted page, not persisted across closing/reloading it. Other forms outside `SettingsForm`, other browsers, assistive technology, live CV model output and representative human task success remain outside this check.
