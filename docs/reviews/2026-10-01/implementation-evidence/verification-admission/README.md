# Verification admission checks — 1 October 2026

The tests used a dedicated local PostgreSQL database at `127.0.0.1:55439/score_pub_review_1001`. The worker and web suites were run **sequentially** because both mutate their test database. The fake AI clients cannot make paid provider calls. No deployment was made.

| Check | Exact command | Result | Log |
| --- | --- | --- | --- |
| Worker score admission, Library review and legacy CV build | `TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:55439/score_pub_review_1001' pnpm --filter @ava/worker exec vitest run src/score-admission.test.ts src/library-review.test.ts src/cv.test.ts` | 3 files, 53 tests passed | [worker-targeted.txt](worker-targeted.txt) |
| Web score-state wording | `TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:55439/score_pub_review_1001' pnpm --filter @ava/web exec vitest run lib/queries/jobs.test.ts` | 1 file, 21 tests passed | [web-score-wording.txt](web-score-wording.txt) |
| Web first-confirmation recovery | `TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:55439/score_pub_review_1001' pnpm --filter @ava/web exec vitest run lib/accounts.test.ts` | 1 file, 24 tests passed | [web-account-claim.txt](web-account-claim.txt) |
| Worker learning and reason-page recovery | `TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:55439/score_pub_review_1001' pnpm --filter @ava/worker exec vitest run src/learning-signals.test.ts` | 1 file, 29 tests passed | [worker-learning-resume.txt](worker-learning-resume.txt) |
| Worker typecheck | `pnpm --filter @ava/worker typecheck` | Passed | [worker-typecheck.txt](worker-typecheck.txt) |
| Web typecheck | `pnpm --filter @ava/web typecheck` | Passed | [web-typecheck.txt](web-typecheck.txt) |

The focused regression tests confirm that an unconfirmed member's queued A5 admission and direct A5 task create no score task or provider call, a direct account AI engine call makes no provider call or budget hold, the Library keeps its deterministic rules baseline without an A12 call, and a legacy CV draft fails with an actionable confirmation message while closing any running build step. A view blocked by verification remains eligible for a later full pass even if its input hash matches the last completed pass. Verified-account behaviour is exercised by the existing tests in the same suites.

## Final candidate after account-claim and Learning fixes

The earlier rows above record the first admission check on `score_pub_review_1001`; their logs are retained as historical evidence. The following checks ran sequentially on the separate dedicated local database `score_pub_agent_1001` at the same port, after the final source changes. No production database, paid model or deployment was used.

| Check | Exact command | Result | Log |
| --- | --- | --- | --- |
| Account confirmation, reset, Google linking, atomic rollback and lock races | `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55439/score_pub_agent_1001 pnpm --filter @ava/web exec vitest run lib/accounts.test.ts --maxWorkers=1` | 29 passed | [web-account-claim-final.txt](web-account-claim-final.txt) |
| Verification policy and settings | `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55439/score_pub_agent_1001 pnpm --filter @ava/web exec vitest run app/actions/verified-work.integration.test.ts app/actions/settings.integration.test.ts --maxWorkers=1` | 11 passed | [web-verification-settings-final.txt](web-verification-settings-final.txt) |
| Decision actions | `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55439/score_pub_agent_1001 pnpm --filter @ava/web exec vitest run app/actions/decisions.integration.test.ts --maxWorkers=1` | 17 passed | [web-decisions-final.txt](web-decisions-final.txt) |
| Bulk and single web actions | `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55439/score_pub_agent_1001 pnpm --filter @ava/web exec vitest run app/actions/actions.integration.test.ts --maxWorkers=1` | 61 passed | [web-actions-final.txt](web-actions-final.txt) |
| Worker learning and 100/100/5 reason-page reconciliation | `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55439/score_pub_agent_1001 pnpm --filter @ava/worker exec vitest run src/learning-signals.test.ts --maxWorkers=1` | 29 passed | [worker-learning-final.txt](worker-learning-final.txt) |
| Task registration | `pnpm --filter @ava/core exec vitest run src/tasks.test.ts --maxWorkers=1` | 6 passed | [core-tasks-final.txt](core-tasks-final.txt) |
| Final typechecks | `pnpm --filter @ava/web typecheck`; `pnpm --filter @ava/worker typecheck`; `pnpm --filter @ava/db typecheck` | Passed | [web](web-typecheck-final.txt), [worker](worker-typecheck-final.txt), [db](db-typecheck-final.txt) |
| Final production builds | `pnpm --filter @ava/worker build`; `pnpm --filter @ava/web build` | Passed | [worker](worker-build-final.txt), [web](web-build-final.txt) |

The account tests prove that a saved seed, standing decisions and shortlisted role create only account-level recovery tasks on first confirmation; 205 untagged reasons are paged by the worker, not inserted in the claim transaction. Injected enqueue failures roll back confirmation or reset together with token use, password replacement and session revocation. A linked Google account retries a rolled-back claim. The lock tests observe waiting PostgreSQL sessions before releasing concurrent account writes, including a Google link that must preserve a newly set password. Repeat claims enqueue no new work. [Browser verification](BROWSER-VERIFICATION.md) covers the desktop and phone Learning flows with no paid calls.

An existing bootstrap owner row was already admin-eligible before its takeover, so it is outside the new unverified-member recovery transition. A first-confirmation synthesis and reason-tag reconciliation may run concurrently; the synthesis always has saved decisions and the seed, while tags can arrive later. Subsequent score inputs include tag changes, and no claim is made that this ordering eliminates every extra model call.
