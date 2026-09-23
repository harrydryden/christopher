# Release and operational gates

These checks provide repository-visible evidence about the deployed source revisions and one
read-only operational snapshot. They do not deploy AVA, change production data or establish
an uptime guarantee.

## Required GitHub configuration

Set these repository variables under **Settings → Secrets and variables → Actions → Variables**:

| Variable | Value |
| --- | --- |
| `WORKER_HEALTH_URL` | The worker's public `/healthz` HTTPS URL |
| `WEB_HEALTH_URL` | The web application's public `/api/health` HTTPS URL |
| `WORKER_STATUS_URL` | Optional: the worker's `/status` URL, where a worker that keeps `/healthz` to liveness serves its full figures. Unset, the operational check reads them from `WORKER_HEALTH_URL` |

When the worker's `/status` requires a token, also add the secret `WORKER_STATUS_TOKEN` under
**Secrets**, with the same value as the worker's; the operational check sends it as a bearer token.

An absent or malformed variable fails its workflow visibly. The release scripts also require the
40-character lowercase commit supplied by the workflow. The web identity comes from Vercel's
`VERCEL_GIT_COMMIT_SHA`; a deployment that does not report it cannot pass by returning only
`ok: true`.

## Release identity

After CI passes for a push to `main`, Release polls the worker and web endpoints independently for
up to eight minutes. Each job passes only when its endpoint reports both `ok: true` and the exact
commit that CI checked, with one exception for the worker: a merge that changes none of the worker's
inputs (`WORKER_INPUT_PATHS` in `scripts/release-checks.mjs`, the same list as `render.yaml`'s build
filter) does not redeploy it, so the worker passes while it runs an ancestor of the merged commit
whose worker inputs are identical to it. The job checks out full history to compare the two. The
two ten-minute job limits leave time for checkout and setup beyond the bounded eight-minute poll.

This workflow becomes active for these changes only after they merge to the default branch. The
first web check also requires a deployment containing the updated `/api/health` response.

## Operational status

The scheduled workflow runs every fifteen minutes and can also be dispatched manually. It makes
three read-only requests fifteen seconds apart. The table distinguishes gate failures from non-failing budget attention:

| Condition | Threshold | Requirement represented |
| --- | --- | --- |
| Worker stopped or unreadable | Any request error, non-2xx response or `ok` other than `true` | Scans and queued CV work require a running worker |
| Wrong or stale worker release | Missing/malformed commit, or a commit that neither is the default-branch revision running the check nor builds the same worker (an ancestor with identical worker inputs). While that revision was committed less than twenty minutes ago the worker is taken to be deploying: reported as attention, not a failure | Operational readings must come from the release the repository expects, without failing every check that runs during a normal Render build |
| Incomplete telemetry | Any required value absent, non-finite, negative, or a heap fraction outside 0–1 | Missing configuration and incompatible releases must fail visibly |
| Company scans overdue | Ten or more active companies without a successful scan in the database's daily overdue window; one to nine are reported as attention | The product promises daily career-page watching. A few stragglers or sources waiting for a person are expected at a large catalogue; the daily run failing shows as most of it going overdue at once |
| Companies that cannot be scanned | Reported as attention when the worker reports `unscannableCompanies` (no source found, or every source blocked, disabled or awaiting confirmation); never a failure | They need a person, not an alert every fifteen minutes |
| Discovery overdue | At least one enabled discovery source more than one day overdue | Scheduled discovery must continue alongside scans |
| Heap pressure | At least two readings at or above 85% of the V8 heap limit | Matches the worker and Operations warning threshold |
| Database pressure | A positive pool waiting count in at least two readings | Sustained connection waits indicate exhausted process-side capacity |
| Old queue | Any ready task whose scheduled time is at least 15 minutes old | A small number of stuck interactive tasks must not be hidden by a backlog threshold |
| Growing queue | At least 25 ready tasks after growth of at least 10 during the check | Detects accumulation rather than treating every non-empty queue as failure |
| Restart loop | Two process changes, detected by a new worker ID or falling uptime when an ID is reused | One process replacement can be a rollout; two within thirty seconds indicates repeated restarts |
| Persisted restart loop | Two or more `crash_recovery` ledger entries in the last hour | Implements the `restarting` derivation in SPEC R-9.3 even when restarts fall outside the thirty-second sampling window |
| Persistent AI failure | Any call-site/model pair has at least three failed or stalled calls and no successful call in the last hour | Operational heuristic; grouping prevents an unrelated healthy model or feature from masking a broken one, and cancelled sibling calls are excluded |
| Account AI budget attention | At least one account with positive recorded spend since its own reset/month boundary is at or above its configured budget | Reported as non-failing attention per SPEC R-6.11 and R-9.1, without exposing account identity; reaching an account limit is expected product behaviour and does not make global operations unhealthy |

The numerical queue thresholds are operational guardrails, not product promises. A small normal
queue passes while it is younger than fifteen minutes; age fails independently of queue size.
Overdue discovery keeps a zero tolerance. Overdue companies do not: with one alert owner, a check
that fails every fifteen minutes because a handful of the catalogue's companies have a blocked or
missing source teaches the owner to ignore it, and then a real outage goes unseen. The count the
worker reports today still includes companies that cannot be scanned at all; until the worker
separates them (the `unscannableCompanies` figure), a catalogue with ten or more of those keeps
this row red, so read the attention list before acting on it.

The response also reports aggregate AI spend for the last 24 hours and current UTC month, provider
attempt/failure counts for the last hour, and crash recoveries for the last 24 hours. These figures
contain no account identifiers, prompts, errors or secrets. Spend has no deployment-wide failure
threshold: account limits vary and the operator's optional caps may be unset. The account-budget
count supplies actionable attention telemetry instead. A zero budget with zero spend is not warned:
that setting deliberately disables AI and is not overspend.

The scheduled workflow supplies its default-branch `github.sha` as
`OPERATIONAL_EXPECTED_SHA`, and every sample must report a healthy worker built from that
revision: the revision itself, or an ancestor with identical worker inputs, or, for twenty minutes
after the revision was committed, any commit (the deploy in progress). This catches a stale
deployment or a URL pointing at a service on another commit. It cannot distinguish
production from staging if both endpoints run the same commit, so the repository variable still
needs an independently reviewed production URL.

The additional fields are required rather than defaulted to zero. Deploy the compatible worker
release before enabling this scheduled check; an older `/healthz` response fails visibly instead of
creating a false pass for restart, provider, spend or account-budget monitoring.

Scheduled workflows run from the default branch, so this schedule starts only after merge. GitHub
records a failed check, but delivery to a person depends on repository notification settings and
operational ownership. The owner must configure and prove those notifications; this repository does
not claim that a failure is delivered through email, chat, paging or an issue tracker.
Harry is the named owner, but a successful test notification received by Harry remains external
release evidence. Neither a green workflow nor a deliberately failed local check proves delivery.

Run the pure checks locally with:

```sh
pnpm exec node --test scripts/*.test.mjs
```

Run the read-only operational check against a configured worker with:

```sh
WORKER_HEALTH_URL=https://example.invalid/healthz \
OPERATIONAL_EXPECTED_SHA=0123456789abcdef0123456789abcdef01234567 \
node scripts/verify-operational-status.mjs
```

## The worker image in CI

CI's `worker-image` job builds the Dockerfile with BuildKit, keeping layers in GitHub's cache, then
boots the image against the job's PostgreSQL and waits up to ninety seconds for `/healthz` to
report `ok: true`, and checks that PID 1 is `tini` and the process is not root. The budget for the
job is ten minutes; the estimate is about four cold (pulling the Playwright base image, installing
the worker's dependencies, exporting the image) and less when the lockfile is unchanged and the
install layer is reused. That estimate is reasoned from the image's size, not yet measured on a
runner: the first runs should confirm it, and if the job regularly exceeds ten minutes the build
belongs on the release path instead of every pull request. `scripts/deploy-config.test.mjs`
separately checks, without Docker, that the base image's Playwright version equals the worker's
pinned `playwright`, that every file the image copies is a worker input, and that `render.yaml`'s
build filter equals `WORKER_INPUT_PATHS`.

## Confirmed operating requirements and configuration — 20 September 2026

Harry is the operational alert owner. The agreed target is 100 registered users with about ten active
at once, a recovery point objective of 24 hours, and a recovery time objective of four hours.

Both GitHub repository variables were set and verified during the gate follow-up:

- `WORKER_HEALTH_URL`: `https://christopher-worker.onrender.com/healthz`
- `WEB_HEALTH_URL`: `https://christopher-web-kappa.vercel.app/api/health`

The web alias was verified in Vercel's signed-in production deployment dashboard, then its health
endpoint returned `ok: true`. The currently deployed base predates web commit identity, so it cannot
pass the candidate's release check yet. These variables do not activate unmerged workflows.

Render's service notifications inherit the workspace default, **Only failure notifications**. This
is configuration evidence, not evidence that Harry received an alert. The service health-check path
was changed to `/healthz` with Harry’s explicit approval at 09:00 UTC. Render’s API confirms the
saved setting. Its configuration-triggered rollout `dep-danq15h42hec73fb3u0g` became live at
09:00:40 UTC on the existing `6a0ad4a` revision; the public endpoint returned HTTP 200 and `ok: true`.
The local release candidate has not been deployed. No test notification was sent.

The managed database dashboard reports a **three-day point-in-time recovery window** and 14.95% use
of its 1 GB disk. An isolated restore at the available 20 September 08:28 UTC recovery point is
created with Harry’s explicit approval as `christopher-recovery-drill-20260920`
(`dpg-danq11ijnfac739fekdg-a`) at 08:59:50 UTC, with an approved $7.50/month charge prorated by the
second. The API confirms 5 GB storage and the 0.1 CPU/256 MB plan. It was initially
`recovery_in_progress` initially, then became available. The first successful read-only aggregate
check at 09:05:06 UTC was 315.35 seconds after creation. All four checked orphan counts and the
unvalidated constraint count were zero; 34 migrations were present. [Managed recovery evidence](benchmarks/managed-recovery-2026-09-20.json)
records the complete aggregates. This passes the managed-restore/internal-consistency sub-check,
not the full recovery gate: no historical baseline, application recovery or rollback was verified. The copy has
not been connected to an application or worker. Production data has not been changed. The recovery
objectives remain requirements until the full recovery journey is demonstrated.

Vercel's request log for the production health request at 08:35:12 UTC shows routing from London
(`lhr1`) to **Frankfurt (`fra1`)**, matching `apps/web/vercel.json`. Its 126 ms execution and 228 MB
Fluid memory are a single-request observation, not a load test. The dashboard's `iad1` default does
not override this observed execution evidence. Production shows Node 24.x; the release candidate
now pins the web package to Node 22.x to align with CI and local verification. This changes the
runtime only after a deployment of the candidate.
