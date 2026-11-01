# Test-suite review — 31 October 2026

## Scope and method

This review inventories the entire checked-in automated suite and examines selected high-risk contracts in depth. It does **not** claim a manual line-by-line audit of every assertion. The starting point is `257be668`, including the ranked CV priorities and compact PDF changes. The objective is to improve fault detection and maintainability, not to maximise or minimise the test count.

The inventory excludes dependencies, build output and historic evidence copies. It contains 362 `*.test.*` files:

| Area | Files | Main responsibility |
| --- | ---: | --- |
| Core | 54 | ATS extraction, filtering, discovery, evidence/provenance, CV contracts, allocation and fitting |
| AI | 12 | Structured requests/responses, grounding, recording/replay, pricing, concurrency and batch handling |
| Database | 14 | Migrations, ownership-bearing persistence, task deduplication, credit accounting and query contracts |
| Worker | 70 | Queue execution/recovery, catalogue scans, closure safety, enrichment, scoring and resumable CV builds |
| Web | 187 | Authorisation, two-account isolation, server actions, HTTP contracts, read models and component behaviour |
| Release/performance scripts | 25 | Qualification, spending limits, deployment/recovery checks, load and performance gates |

The browser smoke scripts are additional end-to-end journeys, not included in this file count. They exercise signed-in navigation, CV preparation/Save/Check/finalisation/download, applications and evidence flows. Hosted Lighthouse, bundle and worker-image gates provide separate integration evidence.

## Test strategy retained

- Keep real database tests for credit idempotency, ownership, lifecycle locks, queue deduplication and migrations. A mocked return value cannot establish these contracts.
- Keep deterministic fake-provider tests for AI request construction, structured-output validation and failure handling. They do not establish live model quality; explicit capped live qualification remains a separate release gate.
- Keep component interaction tests for input retention, pending/error states, stale-response handling and preview cancellation. Browser smoke tests verify the assembled route/action/data journey; these are complementary layers rather than automatic duplicates.
- Keep static checks when source structure is the contract: Next function-duration declarations, server-action export classification, client/server import boundaries, SQL migration constraints and selected index access. Do not replace a meaningful architecture guard simply because it reads source text.
- Avoid asserting incidental prose, internal call ordering or copying invalid fixture JSON when the intended contract is persisted behaviour. Prefer a valid fixture, a discriminating input and an observable result.

## Execution and isolation

Database suites fail if their test database is unavailable; they do not silently pass without it. The worker's Chromium suite has an explicit `COL_DISABLE_BROWSER` switch and is exercised separately in CI. Two release-script cases require a database and skip when it is absent; final verification must supply the database environment so these run.

The existing package dependency order serialises database, worker and web suites. Their destructive test setup must not run concurrently against the same database. In-package file parallelism is disabled where required. This review uses only the retained isolated local test database; no production data, paid model calls or live service mutations are part of the test run.

## Changes and evidence

| Area | Finding | Change and behavioural evidence |
| --- | --- | --- |
| Qualification spending | Negative or non-finite prior spend could make the available budget invalid or artificially generous. | Reject these inputs before a hold; cover exhausted valid prior spend separately. The existing ceiling is unchanged. |
| Generated-CV grading | The page-limit comparison accepted zero, negative and `null` page counts. | Require a positive integer within the existing two-page qualification limit. Test malformed counts and each required coverage outcome independently. |
| Provider readiness | Multi-model qualification and malformed responses lacked direct regression coverage. | Verify distinct selected models are checked, one unavailable model fails the whole probe, requests carry a cancellation signal, and transport/malformed responses cannot pass or leak diagnostic secrets. All responses are synthetic. |
| CV Save/Check | A copied-plan fixture used an invalid object cast to the plan type, proving only that JSON was copied. | Use a genuinely validated evidence plan. Assert free saves create no CV task; repeated explicit Check creates one assess task and no CV-credit reservation. |
| CV assessment reuse | Existing tests distinguished changed wording from layout-only changes, but did not directly isolate a changed effective requirement with unchanged CV wording. | Establish the same targeted source/presentation baseline, change the requirement meaning, then require a fresh factual audit without authoring or changing saved wording. |
| Account isolation | Existing two-account tests covered exports and other mutations but did not directly exercise ordinary CV Save and Check together. | Foreign and nonexistent IDs return equivalent failures, with no change to drafts, tasks, credit reservations or Libraries. |
| Preview validation | Several bad-input cases shared an opaque loop and did not prove downstream work was avoided. | Label each invalid input and assert it never reaches quota or draft lookup; a missing owned draft cannot return a PDF. Keep existing throttle ordering. |
| Lifecycle concurrency | A real lock-window test polled indefinitely and released its connection without rollback on failure. | Bound the wait, prove the competing delete really blocked, and roll back and settle the pending operation on failure so it cannot poison later tests. |
| Qualification subprocess | A test launched `pnpm` and `tsx` solely to run an existing script, introducing unnecessary startup and IPC dependencies. | Run Node with the existing `tsx` import, check process-start errors explicitly and clean up its temporary fixture. |

These changes replace weak fixtures/control flow rather than deleting distinct edge cases. A source check and a database test are not redundant when one guards an architectural boundary and the other proves runtime behaviour. No coverage threshold, test timeout, performance budget, authorisation rule or factual qualification threshold is relaxed.

### Important coverage retained after review

| Contract | Why the existing layers remain useful |
| --- | --- |
| Catalogue discovery and recovery | Core catalogue/ATS tests validate classification and extracted results; worker host guards, partial-publication, periodic recovery and enrichment tests exercise network/task state and closure safety. They do not cover the same boundary. |
| Queue retries and deduplication | Database cases distinguish queued absorption, a follow-up requested while running, per-draft CV uniqueness and priority promotion. Worker cases additionally exercise ownership, failure, checkpoint persistence and recovery. |
| Credits and billing | Real database tests cover reservations, duplicate grants and release/consumption; web tests establish who may invoke those operations. Neither layer substitutes for the other. |
| Evidence and page fitting | Core tests distinguish omitted sources, retained qualifications, essential evidence and actual page limits. Renderer tests and browser export flows separately establish document and route behaviour. |
| Saved-plan reuse | Existing worker coverage already checks two successive free saves, deletion of the parent, zero new planner/rubric calls and invalidation when the Library changes. The repaired web fixture now supplies a valid plan to that contract. |
| AI input boundaries | Prompt/schema/version and hostile-input assertions cover escaping, source attribution and structured requests. Replacing these with broad snapshots or a mocked success would weaken the guard. |
| Frontend work and accessibility | Preview single-flight/cancellation, polling recovery, lazy disclosures, stale editor state and responsive browser journeys remain distinct checks. No frontend runtime was changed in this review. |

### Verification

Local verification passed:

- Core: 790 tests across 54 files; AI: 207 tests across 12 files.
- Database: 119 tests across 14 files.
- Focused web: CV actions 35, preview 5, account isolation 3 and lifecycle 32.
- Workspace and evaluation-script typechecks passed.
- Release-script baseline: 140 passed, two database-dependent cases skipped without a database. New evaluation and provider regressions passed separately; the complete updated release suite still needs its database-enabled CI run.
- Two added regressions were first observed failing (invalid prior spend and invalid page count), then passed after the bounded fixes.

The first complete worker run suffered a large host clock/suspension gap and reported 12,861 seconds with lease/time-limit failures. A second attempt also encountered a clock gap despite an idle-sleep guard. Neither is claimed as a clean full run. Full normal, shuffled worker, browser and database-enabled release validation is delegated to the pull request's hosted CI. No timeout or assertion was relaxed in response. The final cache-isolation fixture is included in that full run; earlier focused success is not substituted for verification of its final revision.

### Limits of the evidence

- Mock-provider and replay tests establish input/output contracts, provenance checks and repeatability. They cannot predict the quality or availability of a future live model response.
- Local query-count/index assertions establish bounded work and supported query access, not hosted latency or capacity guarantees.
- Passing tests do not demonstrate that every production combination is covered. The highest-risk transitions are tested explicitly; existing browser, performance, security and live qualification gates remain necessary.
- No speed percentage is claimed. The subprocess change removes an avoidable launcher/IPC dependency; measured full-suite duration is reported as a local diagnostic, not a before/after benchmark.
