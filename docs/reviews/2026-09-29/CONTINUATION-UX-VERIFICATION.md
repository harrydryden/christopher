# Continuation and accessible reading — development checkpoint

This is a further local development checkpoint on `codex/jtbd-90`, following `4a93828`. It improves large-listing coverage, recovery and enlarged-text use. It does **not** certify the requested 90/100 outcome. Astra coordinated the design and cross-review; Sol implemented three bounded workstreams. No production deployment, external notification or paid-model call was made.

## What changed and why

Large HTTP listings can now continue across claims of the same queue task. Each claim reads at most 20 additional pages and yields after a 100-second fetch budget, within the existing three-minute task deadline. Pages are staged durably, with source-configuration and task-ownership checks. Resumption revalidates the first and boundary pages; changed sources or listings restart within fixed limits. Repeated URLs, repeated role sets, unmet advertised counts and resource limits produce partial evidence rather than closing unseen roles. Completed source commits are idempotent, and the daily run remains open while its task is queued or running. Generation limits are 600 pages, 5,000 roles, 3 MB of parsed page data and two hours, with at most two restarts. These are recovery bounds, **not** proof of the 15-minute daily-run performance target.

Migration 0047 introduces generation/page storage and a unique task/source scan marker. Migration 0048 records cumulative claim metrics and elapsed time. Interrupted attempts make precise traffic/duration totals unavailable instead of reporting only the final claim as the whole scan. Both migrations were exercised locally; neither was deployed. The new task foreign key exposed bare task truncations in test fixtures, which required cleanup changes rather than weakening the production constraint.

Browser listings retain compressed captures within a fixed memory budget and decode one at a time. Explicit Next/Load more controls are tried before scrolling. The renderer waits for changed job identities to settle, rather than treating a page-counter change or unrelated network-idle timeout as proof that new jobs arrived. Extraction merges every observed location, including a later remote option, for a repeated posting URL. Container selection avoids taking another role's location from a surrounding grid.

Health displays unfinished listing reads, their page/entry counts and the next step. Interrupted reads contribute to Needs you; active queued work does not. New successful scans and newer retries suppress obsolete progress, and paused companies are excluded. Zero company issues no longer implies that the background worker is healthy. Roles and Library employment use a container-relative threshold that accommodates enlarged text; the same controls become cards. Decision fields retain visible role/company context, and Library conflict recovery receives keyboard focus without stealing it again when a choice changes.

## Evidence and its limits

The [browser source audit](SOURCE-BROWSER-CAPTURE-REPORT.md) preserves baseline, intermediate failures and final observations. Datadog rose from 190 to 414 distinct posting URLs, matching its displayed 414 jobs; Cloudflare rose from 225 to 402; Stripe rose from 153 to 662 and reached page 63 of 63. These are current machine observations of public listings. Cloudflare and Stripe still lack independently qualified posting denominators. Wise correctly remains partial because its next-page URL is disallowed by its published robots rules.

The [keyboard and enlarged-text audit](implementation-evidence/zoom-keyboard-audit.md) records setup, role decisions, Health, employment editing and actual conflict recovery on disposable accounts. Tables/cards fit at 1280, 1440 and 1600 pixels with doubled computed text sizes, including dynamically created fields. This is text-enlargement emulation, not native browser zoom, a screen-reader assessment or a user study. Invalid intermediate screenshots were replaced after cross-review found that newly created controls had not been enlarged.

The [Siemens continuation audit](implementation-evidence/source-audit/SIEMENS-CONTINUATION-LIVE.md) ran four real claims in two separate processes. It retained 80 pages/480 entries in about 230 seconds, using 81,168 bytes of stored metadata. The same queued task survived the process boundary; no scan or final job set was prematurely published. The site advertises `999+` results, so at least 167 pages are needed. Its actual size is unknown: this bounded audit establishes resumption, not terminal coverage or the 50-company/15-minute gate.

## Re-score judgement

Independent Sol review and Astra integration retain the scores in [RESCORE-90](RESCORE-90.md). J2 remains **77** (C4/R3.5/UX4), and J8 remains **83** (C4.5/R4/UX4). The observed defects are repaired, but independent full-source precision/recall, the complete exception matrix and user recovery evidence remain absent. No other job receives a score increase from work outside its evidence scope. The target remains every job at least 90 with the specified dimension floors.

The [next discovery development plan](DISCOVERY-NEXT-PASS.md) orders the remaining work: block filtered-page confidence promotion, follow a bounded second explicit listing hop, verify rich dynamic listings and retain official-link provenance across vendor boundaries. This targets observed source-discovery defects without lowering the acceptance threshold. Full-corpus discovery and independently labelled extraction must then be rerun, while qualifying real CV/import outputs and user journeys. Provider promotion protection, hosted restoration/alert receipt and genuine learning decisions remain separate outstanding requirements. Local test success cannot substitute for those observations.

## Integrated verification

All database-backed checks use disposable local PostgreSQL databases on port 55439.

| Check | Result | Scope |
|---|---|---|
| `pnpm --filter @ava/core test` | 687 passed, 40 files | Final parser/location changes included |
| `pnpm --filter @ava/ai test` | 184 passed, 11 files | Fixtures; no live provider qualification |
| `TEST_DATABASE_URL=…/ava_test pnpm --filter @ava/worker test` | 708 passed, 54 files | Final clean full run after all parser, continuation and fixture changes |
| `TEST_DATABASE_URL=…/ava_db_final pnpm --filter @ava/db test` | 98 passed, 10 files | Includes migrations 0047/0048 and corrected task cleanup |
| `TEST_DATABASE_URL=…/ava_web_final pnpm --filter @ava/web test` | 1,230 passed, 138 files | All interface suites, including Health progress/count and corrected fixture cleanup |
| `TEST_DATABASE_URL=…/ava_harness_final pnpm test:release` | 119 passed, none skipped | Migrated empty database; harness tests, not an actual qualified release |
| `pnpm typecheck` | Passed all five packages | After production build generated route types |
| `pnpm build` | Passed | Worker bundle and production Next.js build |

The first database invocation omitted `TEST_DATABASE_URL` and failed against the unavailable default port 5432; it is not counted as a successful check. The corrected database run exposed the new task foreign key's effect on test cleanup. Full test-reset boundaries now cascade explicitly, while within-test task clearing uses `DELETE` so existing scan rows survive through `ON DELETE SET NULL`. The initial worker suite also exposed CV fixtures with multi-table truncations; those now delete tasks separately before clearing their CV tables. No production constraint was removed to make tests pass.

The release-harness run first passed 117 tests with two database checks skipped. A new empty database then exposed its documented prerequisite: migrations must already exist. After migrating that disposable database, all 119 passed with no skips. None of these runs constitutes hosted CI, a provider deployment or a verified model replay.

The six final suites total **3,026 passing tests**. The earlier worker runs reported 55 then 53 fixture-setup failures; the affected CV subset passed 53/53 after repair, and a subsequent clean full worker run passed all 708. These failed intermediate runs are retained as part of the audit trail rather than presented as clean runs. A [verification manifest](implementation-evidence/continuation-verification.json) records final log hashes and implementation-file hashes. `git diff --check` and local report-link checks also passed.
