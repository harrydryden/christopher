# Acceptance audit evidence — 2 October 2026

See [the checkpoint](../../HEALTH-ACCEPTANCE-VERIFICATION.md) for conclusions and limitations.

- `full-web-tests.txt`: initial baseline diagnostic, nine bundle assertions failed.
- `full-web-tests-after-repair.txt`: failed intermediate split; malformed UUID expression, subsequently corrected. Not acceptance evidence.
- `full-web-tests-final.txt`: frozen repaired candidate, 150 files and 1,358 tests pass, exit 0.
- `web-build.txt`: production web build, exit 0, after the local dev server stopped.
- `strict-model-gate.txt`: current verified report gate fails; no current verified quality qualification.
- `corpus-composition.txt`: 31-case composition passes; no extraction-quality claim.
- `seed-health-browser.ts`, `health-fixture.json`: isolated synthetic database and account/company identities, not genuine usage. Session cookies are not retained.
- `admin-controls.txt`, `member-controls.txt`: administrator/member control inventories.
- `member-phone.png`: inspected 375px member view.
- `stale-refusal.txt`, `stale-refusal-state.txt`, `stale-refusal-phone.png`: frozen-source stale member choice shows an alert and retains the pasted URL; document width equals viewport width.
- `browser-database.txt`: successful initial choice resolved with one source and one scan; refused stale choice unresolved, only its pre-inserted working source, zero scans.
- `INDEPENDENT-REVIEW.md`: independent source review and next bounded J7 implementation design.

Browser actions used `npx --yes agent-browser --session health-member` and a separate `health-admin` session at `http://127.0.0.1:3151/health`. The server used isolated `ava_health_permissions_ui_1002`, disabled serverless fallback and no provider key. The stale state was created by inserting a synthetic working source after page load. No worker ran. An earlier attempt during hot reload is excluded; the captured passing attempt followed source freeze. Both browser sessions and the dev server were closed; synthetic cookie files were removed. Fixture databases remain available.

Health focused tests/typecheck/diff logs are alongside the preceding checkpoint in `../learning-completion/health-permissions-*.txt`. Those test counts overlap the full suite. Text log trailing whitespace is normalised for repository hygiene without changing results.
