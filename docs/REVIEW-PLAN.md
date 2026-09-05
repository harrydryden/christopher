# Functional review and development plan

Reviewed 5 September 2026 against SPEC v0.1 and the current main branch.

## Release assessment

The repository has a substantial implementation and deterministic coverage, but passing existing tests is not evidence that every specification requirement is delivered. The release must distinguish fixture verification, browser verification and live provider verification.

## Priority 1 — correctness and regression coverage

1. Refresh posting metadata, descriptions and gate results on subsequent scans. Preserve missing counters on non-ok scans. Fetch descriptions independently of AI availability or spend.
2. Require confirmation when rediscovery proposes a different source. Preserve confirmed sources and prevent repeated confirmation creating duplicates.
3. Finish daily runs only when all associated work is terminal; account for companies without usable sources. Serialise fan-out creation with finalisation.
4. Apply keyword/location changes before the save request returns. Update matched-term chips even when membership stays unchanged.
5. Enforce the near-miss daily allowance atomically at execution, including rescores and settings-triggered work.
6. Protect mutation boundaries with session checks; preserve decision history and serialise competing decisions.
7. Exclude archived companies from the inbox and put unscored roles last in fit ordering.

## Priority 2 — full specification acceptance

- Verify generic HTML pagination/recipe invalidation, RSS/Atom discovery, detail refresh, extraction completeness and raw response retention against fixtures.
- Exercise company deletion with retained decision snapshots, grouped-role decisions, editable tags and profile version history through the browser.
- Verify scheduler DST/midnight behaviour, task lease recovery, per-company deadlines, source scan concurrency and AI budget reservations across worker processes.
- Audit HTTP and browser fetching together for robots compliance, redirect/DNS target validation and bounded resource use.
- Add production build and authenticated browser journeys to CI, with a disposable database and no paid model calls.

## Priority 3 — release evidence

- Record a representative real-company golden set and manual posting counts; measure discovery precision and extraction recall against section 9.
- Validate configured model availability and pricing, live provider APIs, deployment configuration, backups and restore.
- Run a 50-company soak, verify failures in Health and obtain a week of operational evidence.
- Measure learning agreement once sufficient real decisions exist. Do not claim the calibration target from synthetic decisions.

Each completed item must name its regression coverage. Outstanding items remain release gates; the specification must not silently redefine them as delivered.

## Development delivered in this review

Base commit: `6681fc061f0ee37bee8cbc4a3675040d61630660`.

| Finding and impact | Change | Evidence |
|---|---|---|
| P1: updated postings kept stale fields and filter results | Refresh supplied metadata, snapshot and gate fields on observation; queue description refreshes without AI | Worker end-to-end tests: changed metadata, descriptions and gate membership; AI-disabled snapshot queue |
| P1: failed HTML extraction could look like an empty board | Mark unverifiable empty HTML extraction failed; reject browser HTTP errors; preserve counters on partial observations | Worker tests: unextractable HTML and partial-scan counters; core tests: minimum two successful misses |
| P1: rediscovery silently added a replacement board | Propose a changed source; retain confirmed state; serialise repeated confirmations | Worker migration-proposal test; web concurrent confirmation test |
| P1: daily runs finished after their first company and could lose deduplicated tasks | Atomic run fan-out/finalisation, run-specific task keys, company scan lock, missing-source accounting | Worker daily-run completion test; cron request suite |
| P1: changing keywords returned before reevaluation | Shared gate reevaluation in the settings transaction, including unchanged membership with new term chips | Web synchronous-save integration test; worker keyword-chip test; interactive browser save with no worker |
| P1: queued near-miss scores bypassed daily allowance | Atomic database reservation before each near-miss score, keyed to the local date | Three concurrent scoring calls with an allowance of one result in one model invocation |
| P1: action calls depended on routing middleware; concurrent decisions could conflict; undo discarded history | Explicit action authentication, role row lock, superseded undo history | Web tests: unauthenticated action, concurrent decisions, undo |
| P1: company deletion cascaded through the learning corpus | Nullable decision job reference with ON DELETE SET NULL migration; confirmed deletion form | Migration applied on existing test database; retained-snapshot integration test |
| P2: unscored jobs rose to the top of descending fit sort | Null scores sort last; archived companies excluded from inbox and near misses | Fit ordering tests; query review |
| P2: CI omitted production build/page checks and browser scraping | Add production smoke test and explicit Chromium suite to CI; pin tracing root to this monorepo | Local production build, smoke checks and Chrome scraping suite |

### Validation record

- Type checking across all five packages.
- Full Vitest suite against isolated PostgreSQL 16, with no paid model calls.
- Browser scraping suite against local fixture pages using installed Chrome.
- Production Next.js build and authenticated smoke check of roles, companies, suggestions, learning, health, settings and CSV export.
- Interactive browser: unauthenticated redirect, password sign-in, populated role table, required skip reason, persisted skip decision, immediate keyword save without a running worker; no browser errors reported.

### Still required before full functionality can be claimed

The Priority 2 items not covered in the table and all Priority 3 acceptance gates remain open. In particular, realistic fixture tests are not a substitute for a supplied live-company list, measured extraction recall, paid-model capability checks, load/soak testing or learning calibration. The review changes are a tested correctness increment, not a release certification.

The decision-retention migration must run before deploying the new web actions. It preserves existing data, but cannot recover decisions already deleted by the old cascade. HTML sources that produce no verifiable postings now require attention rather than automatically closing their last roles; a trustworthy empty-page signal remains future work.


## Follow-up development

- Implemented bounded same-origin HTML pagination, posting union, incomplete-page protection, compressed snapshots retained for three scans, and reuse of verified extraction when the page hash is unchanged. Added tests for two-page union, failed later pages, cache reuse without AI and snapshot retention, plus pure pagination-target tests.
- Added full profile editing, immutable versions for edits/pins/answers and optimistic version checks shared with model synthesis. Historical profiles remain read-only. Initial pins can be saved before any model-generated profile exists.
- Added model-proposed tag approval and an editor for recent decisions. A new `tags_edited` column prevents late model results from replacing manual tag edits, including clearing tags.
- Fixed the production smoke script to launch Next.js directly and terminate that process. CI exposed that stopping the previous npx wrapper left a child server alive. A smoke run now renders all seven routes and exits successfully. CI has a 15-minute timeout.

Coverage: `apps/worker/src/e2e.test.ts`, `apps/web/app/actions/actions.integration.test.ts`, and `packages/core/src/ats/pagination.test.ts`. This closes the profile/tag and basic pagination/cache/snapshot gaps above. JavaScript-only pagination, grouped decisions, account controls, the remaining operational guards and live acceptance evidence remain open.

Follow-up local validation: 209 tests passed (including the three Chrome tests run explicitly), workspace type checks and production build passed, and the revised seven-route smoke test exited with code 0.
