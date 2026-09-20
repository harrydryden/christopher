# Release and operational gates

These checks provide repository-visible evidence about the deployed source revisions and one
read-only operational snapshot. They do not deploy Christopher, change production data or establish
an uptime guarantee.

## Required GitHub configuration

Set these repository variables under **Settings → Secrets and variables → Actions → Variables**:

| Variable | Value |
| --- | --- |
| `WORKER_HEALTH_URL` | The worker's public `/healthz` HTTPS URL |
| `WEB_HEALTH_URL` | The web application's public `/api/health` HTTPS URL |

An absent or malformed variable fails its workflow visibly. The release scripts also require the
40-character lowercase commit supplied by the workflow. The web identity comes from Vercel's
`VERCEL_GIT_COMMIT_SHA`; a deployment that does not report it cannot pass by returning only
`ok: true`.

## Release identity

After CI passes for a push to `main`, Release polls the worker and web endpoints independently for
up to eight minutes. Each job passes only when its endpoint reports both `ok: true` and the exact
commit that CI checked. The two ten-minute job limits leave time for checkout and setup beyond the
bounded eight-minute poll.

This workflow becomes active for these changes only after they merge to the default branch. The
first web check also requires a deployment containing the updated `/api/health` response.

## Operational status

The scheduled workflow runs every fifteen minutes and can also be dispatched manually. It makes
three read-only requests fifteen seconds apart. The gate fails on these conditions:

| Condition | Threshold | Requirement represented |
| --- | --- | --- |
| Worker stopped or unreadable | Any request error, non-2xx response or `ok` other than `true` | Scans and queued CV work require a running worker |
| Wrong or stale worker release | Missing/malformed commit, or a commit different from the default-branch revision running the check | Operational readings must come from the release the repository expects |
| Incomplete telemetry | Any required value absent, non-finite, negative, or a heap fraction outside 0–1 | Missing configuration and incompatible releases must fail visibly |
| Company scans overdue | At least one active company without a successful scan in the database's daily overdue window | The product promises daily career-page watching |
| Discovery overdue | At least one enabled discovery source more than one day overdue | Scheduled discovery must continue alongside scans |
| Heap pressure | At least two readings at or above 85% of the V8 heap limit | Matches the worker and Operations warning threshold |
| Database pressure | A positive pool waiting count in at least two readings | Sustained connection waits indicate exhausted process-side capacity |
| Old queue | Any ready task whose scheduled time is at least 15 minutes old | A small number of stuck interactive tasks must not be hidden by a backlog threshold |
| Growing queue | At least 25 ready tasks after growth of at least 10 during the check | Detects accumulation rather than treating every non-empty queue as failure |
| Restart loop | Two process changes, detected by a new worker ID or falling uptime when an ID is reused | One process replacement can be a rollout; two within thirty seconds indicates repeated restarts |

The numerical queue thresholds are operational guardrails, not product promises. A small normal
queue passes while it is younger than fifteen minutes; age fails independently of queue size.
The daily overdue counters are the direct product requirement and therefore have a zero tolerance
once work is beyond that window.

The scheduled workflow supplies its default-branch `github.sha` as
`OPERATIONAL_EXPECTED_SHA`, and every sample must report that exact healthy release. This catches
a stale deployment or a URL pointing at a service on another commit. It cannot distinguish
production from staging if both endpoints run the same commit, so the repository variable still
needs an independently reviewed production URL.

Scheduled workflows run from the default branch, so this schedule starts only after merge. GitHub
records a failed check, but delivery to a person depends on repository notification settings and
operational ownership. The owner must configure and prove those notifications; this repository does
not claim that a failure is delivered through email, chat, paging or an issue tracker.

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
