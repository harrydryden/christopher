# Verification and evidence record

29 September 2026 · AVA `ebb346b1fa64e34c16447fffb0d47afbbfd890ac`

## Environment and isolation

- macOS host; Node `22.18.0`; repository package manager `pnpm 10.33.0`; frozen lockfile installation succeeded.
- Clean worktree: `/Users/h_dryden/Documents/New project/christopher-jtbd-review`, branch `codex/jtbd-forensic-review-20260929`.
- Original checkout `/Users/h_dryden/Documents/New project/christopher` is on local `main`, fast-forwarded from `9585815` to the assessed commit. Pre-existing untracked duplicate files were left untouched.
- New disposable `postgres:16-alpine` container `jtbd-review-postgres-20260929`, loopback port 55439. `ava_test` was used for serial database suites; `ava_review` was used for demo/browser/smoke. No existing or production database was seeded or truncated.
- `AVA_DISABLE_BROWSER=1` for the broad worker test run. Real Chromium was exercised separately through the built web smoke and agent-browser walkthrough.
- Latest agent-browser required Node ≥24; it ran through `npx` under the existing Node 25.2.1 installation. The application build/tests remained on Node 22. No application dependency was added for the review.
- No worker with paid-provider credentials was started for the walkthrough; paid-provider, email and OAuth behaviour were not newly exercised.
- On completion, the review browser and local web server were stopped and the disposable PostgreSQL container removed. The reports, screenshots and logs remain in the review worktree.

## Fresh results

| Check | Result | Evidence and limits |
|---|---|---|
| `pnpm install --frozen-lockfile` | Pass | Clean dependency installation; no lockfile/app changes |
| `pnpm -r typecheck` | Pass, all five packages | [typecheck.log](evidence/typecheck.log) |
| `pnpm typecheck:eval` | Pass | Included in the typecheck log |
| `pnpm --filter @ava/web build` | Pass | [build.log](evidence/build.log); production web build, not a local Docker image build |
| `@ava/core` tests | **660 passed**, 40 files | [tests.log](evidence/tests.log) |
| `@ava/ai` tests | **184 passed**, 11 files | Same log; synthetic/model-client checks, not paid semantic acceptance |
| `@ava/db` tests | **98 passed**, 10 files | Same log; isolated PostgreSQL |
| `@ava/worker` tests | **632 passed, 2 failed, 13 skipped**, 51 files; one unhandled environment error | Same log; failures detailed below |
| `@ava/web` tests | **1,186 passed**, 133 files | [web-tests.log](evidence/web-tests.log); run explicitly after worker failure halted the recursive command |
| `pnpm test:release` | **116 passed, 2 skipped**, no failures | [release-tests.log](evidence/release-tests.log) |
| `pnpm exec tsx scripts/check-evaluation-reports.ts` | Pass **with material warning** | [evaluation-gates.log](evidence/evaluation-gates.log): no verified live report at shipped prompt set `e06dce7dc560` |
| `pnpm smoke:web --no-build` | Pass | [smoke.log](evidence/smoke.log): authenticated routes, RSC, headers, logos, CV browser and tailoring flows |
| Public web/worker health | Both `ok: true`, exact assessed commit | [web-health.json](evidence/web-health.json), [worker-health.json](evidence/worker-health.json); point-in-time liveness/identity only |

The five package suites together recorded **2,760 passing tests, 2 failures and 13 skips**. Release-script tests add 116 passes and 2 skips. The Sol reviewer also ran 89 focused core and 58 focused web checks; those overlap the package suites and are not added again. The overall test run is **not green**.

Commands used for the database suite:

```sh
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55439/ava_test \
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55439/ava_test \
AVA_DISABLE_BROWSER=1 pnpm -r --workspace-concurrency=1 test

# Run the web package explicitly because the recursive command stopped at the worker failure.
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55439/ava_test \
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55439/ava_test \
AVA_DISABLE_BROWSER=1 pnpm --filter @ava/web test
```

The credentials above belong only to the disposable local test container. Database suites were not run concurrently against the same database.

## Failed tests: separate meanings

1. `apps/worker/src/cv-replay.test.ts:161`: expected `report.wallMs > 100`; local result **99ms**. The published-outcome assertion immediately before it passed. The same current-commit CI test failed with **83ms** in the shuffled job. This is a reproducible failed gate and an elapsed-time test assumption requiring repair; it does not demonstrate a user CV build failed. Do not “fix” it by blindly relaxing the timeout without making the intended lease-renewal coverage deterministic.
2. `apps/worker/src/fetcher.test.ts:819`: the loopback redirect test timed out after an unhandled `EADDRNOTAVAIL` when trying to bind `127.0.0.2`. This Mac has no such bindable loopback address. The regular Linux CI check and shuffled worker run passed this test. Record the local environment limitation; it is not evidence that the production SSRF guard is bypassed. No host-network configuration was changed to make it pass.

## Current GitHub evidence

Queried through authenticated read-only `gh` commands; no workflow was dispatched or deployment changed.

- [CI 36485054175](https://github.com/harrydryden/christopher/actions/runs/36485054175), assessed commit: **failure**. `check`, `worker-image`, `browser-and-smoke`, `lighthouse` passed; `order-independence` failed on the timing assertion above. [Job metadata](evidence/ci-jobs.json).
- [Release 36486124405](https://github.com/harrydryden/christopher/actions/runs/36486124405): **skipped**.
- [Operational status 36542834769](https://github.com/harrydryden/christopher/actions/runs/36542834769), 29 September 08:27 UTC: **success**. Summary: 0 ready, 0 running, 0 crash recoveries in 24h, 0/0 provider calls failed/stalled in the hour, $0.00 recorded spend in 24h and $29.63 in the UTC month. This is an idle operational observation, not a load test or reconciliation of provider invoices.

Both health endpoints nevertheless identify the assessed commit. This establishes divergence between deployment state and successful CI/release qualification; the review did not establish how or why it was deployed.

## Browser observations

Local production build at port 3109; synthetic seeded demo account `demo@ava.local`, with no real candidate data. The smoke script ran at a separate port with its own disposable account. The seeded demo is an administrator, so its admin navigation is not assumed visible to ordinary members.

1. Signed in through the real login form. The Roles page showed five matched roles, one shortlisted and two dismissed. Expanded Head of Operations through its Review button. Observed salary, stored description, keyword/location explanation, fit rationale, external vacancy and shortlist/dismiss/archive controls.
2. Captured [desktop Roles](evidence/roles-desktop.png) at the browser's 1280×633 viewport, then [390×844 mobile Roles](evidence/roles-mobile.png). On the mobile first-use state, top navigation/status occupied about 292px and the first role was below the initial viewport after setup, suggestions, tabs and filters.
3. Opened Library → Experience on mobile and added a synthetic job. Submitting incomplete required fields focused the **visible** Job 1 title. Both responsive copies were invalid in the DOM, but there was no JavaScript error or proven hidden-control save blockage. No inline alert was present. Do not report the original static suspicion as a verified P1.
4. Entered Example Company / Operations Lead and one synthetic evidence row. Measured `innerWidth = 390`, document width `390`, responsibility table width `820`, scrolling container width `318`. [Library mobile screenshot](evidence/library-mobile.png) shows horizontal loss of adjacent context. Discarded these unsaved edits through the app's confirmation dialog afterwards.
5. Constructed the zero-role case by deleting **only the disposable demo account's eight `user_jobs` views**, retaining the seeded companies and successful scan records. The root page displayed “Last scan 6m ago” and “Nothing has run yet. Finish these steps to fill your table” simultaneously. [Screenshot](evidence/empty-after-scan.png), 1280×900. This tests the rendering logic for an empty view with past scans; it does not claim that a real extraction/filter run produced the fixture state.

The built smoke separately passed tabs, unified CV evaluation, keyboard navigation, sidebar collapse, saved edits, mobile layout, progress updates, build narration/log, save costs, unavailable finalisation explanation, failed-build recovery, Library readiness/Confirm all/unsaved guard, application stage/CV/archive/restore/delete, unauthenticated share reading/commenting, quiz skip/continuation, Library snapshot immutability and responsive evidence tags. See the script's log for its own precise scope; these scripted paths are not a human usability study.

## Evidence provenance

- **Observed/reproduced now:** build/type results, test results, browser screenshots/measurements, explicit Library import and merge counterexamples, health responses and CI metadata.
- **Code-traced now:** suspect-empty Health omission, concurrent filter acceptance interleaving, in-flight homepage race, due-action ordering, date defaults, import polling threshold and stale quote. These have exact triggers and source locations in the specialist reviews; not every one was dynamically reproduced.
- **Historical repository evidence:** live discovery acceptance, provider evaluations, capacity experiments and managed restore from 20 September. Useful but bounded by their date, corpus, commit/prompt identity and measurement method.
- **Not established:** general production recall, current model semantic quality/cost distribution, user task-success rates, screen-reader accessibility certification, full recovery/rollback, delivered alerts, hosted capacity under the complete operating envelope.

The report deliberately avoids treating a test count, schema validation, a model-generated score or one green endpoint as proof of those broader outcomes.
