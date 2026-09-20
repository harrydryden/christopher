# Capacity and recovery drills

These drills produce local evidence for the 100-registered-user, 10-active-user launch assumption. They are deliberately restricted to named local databases. They never connect to production, clear an occupied database or drop an existing database.

## Authenticated capacity probe

Build the web application and migrate a new empty database named `christopher_users_benchmark`, then run:

```sh
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55439/christopher_users_benchmark \
USERS_REPORT_PATH=/tmp/christopher-users-report.json \
node scripts/benchmark-users.mjs
```

The probe creates 100 verified accounts, 20 shared companies, a mix of ATS and HTML sources, 1,000 shared jobs, 100,000 account role rows, 2,000 subscriptions, and populated Library, CV and Application records for every account. It warms six authenticated routes, performs 600 reads with ten active sessions, runs a simultaneous ten-account write phase, and then performs a separate 100-session read burst.

The write phase records 100 decisions, saves ten Library versions and admits 30 representative review, rescore and interactive scan tasks. It intentionally leaves those tasks queued: completing model and provider work would make this deterministic local probe call external services. The JSON report contains per-route latency/error summaries, database connection samples, process/host memory samples, fixture counts, explicit limitations and machine-readable pass/fail reasons.

The enforced local acceptance thresholds are zero request/write errors, ordinary authenticated read p95 below two seconds and representative transaction p95 below four seconds. Every phase has a two-minute deadline and every HTTP request has a ten-second timeout. These are the proposed thresholds in the production requirements; the owner must still agree them. A pass is local evidence, not production certification.

The script refuses a remote host, another database name, or a database containing claimed users or companies. It retains fixtures and never truncates the database.

## Logical backup and isolated restore

With the populated capacity database available, choose a local target URL for the exact, absent database `christopher_recovery_drill`:

```sh
RECOVERY_SOURCE_URL=postgres://postgres:postgres@127.0.0.1:55439/christopher_users_benchmark \
RECOVERY_TARGET_URL=postgres://postgres:postgres@127.0.0.1:55439/christopher_recovery_drill \
RECOVERY_REPORT_PATH=/tmp/christopher-recovery-report.json \
node scripts/recovery-drill.mjs
```

If PostgreSQL client tools are not installed on the host, set
`RECOVERY_DOCKER_CONTAINER=christopher-release-gates-20260920`. The drill then runs the matching
`pg_dump`, `createdb` and `pg_restore` binaries inside that container and copies only its
temporary custom-format dump to the host for the duration of the check.

The drill verifies source integrity, makes a custom-format logical dump, creates the isolated target, restores with `--exit-on-error`, reruns current migrations, and compares core table counts plus a deterministic account-role fingerprint. It also checks four orphan classes, unvalidated constraints, the migration count, PostgreSQL compatibility and tool exit status. The report records elapsed time and each command duration.

The target must not already exist. The script will not delete it before or after the drill; inspect it, run an authenticated smoke journey against it if required, and remove it manually only when its evidence is no longer needed. This prevents an accidental overwrite and preserves the failed or successful restore for diagnosis.

This drill proves only that a current local logical backup can restore into the same PostgreSQL server and that current migrations remain idempotent. It does not prove managed backup scheduling, retention, encryption, point-in-time recovery, production RPO/RTO or rollback of a release with irreversible schema changes. Those remain release-owner and hosting-provider gates.

Run the fast guard tests with:

```sh
node --test scripts/benchmark-users.test.mjs scripts/recovery-drill.test.mjs
```

## Browser-capable worker envelope

`pnpm capacity:worker` runs the real three-lane queue and `verify_company` handler against private
fixture pages. It requires the exact fresh local database named by the harness, refuses any remote database or paid AI credential,
and writes `CAPACITY_REPORT_PATH`. Run the worker image with `--memory=512m --cpus=0.5`; the harness
creates 100 claimed accounts, assigns the work across ten active accounts, serves 1.19 MiB
JavaScript shells which Chromium renders, and runs three iterations of three verification tasks.
It samples process RSS, cgroup memory and cgroup CPU every 250 ms and fails if a task fails or two
verification intervals overlap. The database is retained and the container should be stopped after
the run.

The first 20 September observation completed all nine tasks with no overlap, restart or OOM, but
sampled the whole 512 MiB cgroup at 511.9 MiB. That observation did not split anonymous memory from
cache and its report incorrectly called workload completion a pass; it is retained unchanged as
[`worker-capacity-browser-initial-observation-2026-09-20.json`](benchmarks/worker-capacity-browser-initial-observation-2026-09-20.json), not used as acceptance evidence.

The corrected 512 MiB run completed all nine tasks in 35.34 seconds with no overlap, restart or OOM,
but **failed the 70% headroom gate**. Peak cgroup use was 466.8 MiB against the 358.4 MiB gate:
391.8 MiB anonymous memory and 57.1 MiB file cache at their respective sampled peaks. Process RSS
peaked at 368.3 MiB. `memory.events` ended with `high=0`, `max=0`, `oom=0` and `oom_kill=0`, so the
kernel did not record a limit hit or OOM; even treating file cache as reclaimable, anonymous memory
alone exceeded the gate. The serial reservation behaved correctly, but the configured tier lacks
the agreed headroom and the local capacity gate is failed. Full evidence:
[`worker-capacity-browser-2026-09-20.json`](benchmarks/worker-capacity-browser-2026-09-20.json).

A bounded repeat at 1 GiB and the same 0.5 CPU completed the same workload in 29.93 seconds and
passed its 716.8 MiB headroom gate. The harness read the actual cgroup limits as 1,024 MiB and 0.5
CPU. Peak cgroup use was 411.1 MiB (381.9 MiB anonymous, 5.6 MiB file cache), process RSS peaked at
362.0 MiB, and all memory event counters remained zero. This is local evidence that 1 GiB provides
headroom for this fixture; it is not a hosted plan change or hosted acceptance. Full evidence:
[`worker-capacity-browser-1g-2026-09-20.json`](benchmarks/worker-capacity-browser-1g-2026-09-20.json).

The synthetic server and PostgreSQL run outside the worker cgroup. This drill does not model public
provider latency, Render scheduling, remote PostgreSQL latency or PgBouncer, and it makes no paid AI
call. The 100-account/ten-active authenticated web measurements above remain the web-side evidence;
this drill adds the production-shaped worker path.

## Restored application compatibility follow-up

`scripts/recovery-read-smoke.mjs` is a guarded GET-only application journey for the retained local
`christopher_recovery_drill` database. It starts the built web application, signs an existing
synthetic session and requests `/`, `/companies`, `/applications`, `/library` and
`/api/work-status`; it refuses any remote or differently named database.

The retained restore's original synthetic sessions had expired before the 09:42 UTC attempt. That
attempt produced four redirects and an API 500 and is retained as diagnostic evidence in
[`recovery-read-smoke-expired-session-2026-09-20.json`](benchmarks/recovery-read-smoke-expired-session-2026-09-20.json).
The redirects were the expected consequence of the expired fixture. The API 500 exposed a separate
route defect: a validly signed cookie naming an expired database session reached the route and its
uncaught authentication error became a 500. `/api/work-status` now performs the database-backed
session check explicitly and returns JSON 401; focused tests cover both missing/expired current-user
state and a live session. The expired fixture itself was not an external blocker.

The completed rerun inserted one dedicated, 15-minute session row for an existing claimed synthetic
account, signed its local-only cookie, and removed the row in `finally`. This setup and cleanup are
the only database mutations; the application journey itself remained GET-only. `/`, `/companies`,
`/applications`, `/library` and `/api/work-status` all returned HTTP 200, in 6.5–128.2 ms, and the
report confirms the dedicated session was removed. The harness then reused the still-valid signed
cookie after deleting its database session: the built application returned HTTP 401 with
`Cache-Control: private, no-store` and the JSON instruction to sign in again. A direct database
check found no dedicated smoke sessions left afterwards. Evidence:
[`recovery-read-smoke-2026-09-20.json`](benchmarks/recovery-read-smoke-2026-09-20.json). The earlier
isolated restore evidence also remains valid: it rendered authenticated routes and completed the
Chromium CV/Library/Application/share workflow against the restored synthetic database
(`local-restore-2026-09-20.json`).

Roll-forward compatibility remains covered by the recovery drill rerunning all current migrations
on the restored schema. For rollback, the immediate predecessor of `519fbc6` has the identical
migration journal SHA-256
`ba58eda6c688c8da05d6c350210a704fe9f88adfa3f8bc2092480f2f07e77824`, and the commit introduces no
database migration diff. This proves there is no schema migration delta between these two revisions;
it does not prove runtime rollback compatibility or that an older application artefact starts and serves traffic, because no immutable
previous web build is retained locally. Destructive down-migration testing remains deliberately
excluded.

## Executed local evidence — 20 September 2026

The populated workload ran against PostgreSQL 16 in the isolated
`christopher-capacity-gates-final-20260920` container. All fixture checks matched: 100 accounts,
100,000 account-role rows, 110 Library versions, 100 completed CV records, 100 Applications, 100
decisions and 30 admitted tasks.

| Phase | Requests/operations | Errors | p95 | Throughput |
| --- | ---: | ---: | ---: | ---: |
| Ten active users, authenticated reads | 600 | 0 | 267 ms | 74.12 requests/s |
| Ten active users, decisions/Library saves/queue admission | 10 transactions: 140 writes | 0 | 11 ms | n/a |
| Separate 100-session authenticated burst | 600 | 0 | 2,035 ms | 86.75 requests/s |

The ten-active-user phase and representative write target passed. The overall capacity probe is
recorded as **failed** because the separate burst missed the proposed two-second p95 threshold by
35 ms. It had no request errors. This is a useful saturation result rather than a production
capacity conclusion. During the short run, 31 resource samples recorded at most 13 local database
connections and the single Next.js process grew from 256 MiB to a sampled 745 MiB RSS. The process
was stopped after the run; a production-like soak is still needed to establish whether memory
settles and whether the hosted web/database topology has adequate headroom. Full evidence:
[`hundred-users-mixed-2026-09-20.json`](benchmarks/hundred-users-mixed-2026-09-20.json).

The logical recovery drill then passed in 1.93 seconds. Source and restored data both held 100
users, 1,000 shared jobs, 100,000 account-role rows, 110 Library versions, 100 CVs, 100 Applications
and 30 tasks. The account-role fingerprint matched; all four orphan checks and the unvalidated
constraint count were zero; all 34 migrations were retained and current migrations reran
successfully. Source and restore used the same PostgreSQL 16 server. Full evidence:
[`recovery-drill-2026-09-20.json`](benchmarks/recovery-drill-2026-09-20.json).

### Authenticated-write and memory follow-up

A fresh isolated PostgreSQL 16 run added real HTTP writes and separated the target workload from
the extra burst. Ten accounts each archived and restored their own populated CV through
`POST /api/cv/manage`; all 20 authenticated mutations succeeded at 68 ms p95. The endpoint returns
the account's saved and archived pages after each committed mutation, so the benchmark verifies
the CV moved to the archive and back rather than treating an HTTP 200 alone as success. Direct SQL
remains only for the separate deterministic decision, Library and queue-fixture phase.

| Phase | Requests/operations | Errors | p95 | Throughput |
| --- | ---: | ---: | ---: | ---: |
| Ten active users, authenticated reads | 600 | 0 | 203 ms | 82.55 requests/s |
| Authenticated CV archive and restore | 20 | 0 | 68 ms | n/a |
| Decision/Library/queue fixtures | 10 transactions: 140 rows | 0 | 14 ms | n/a |
| Ten active users, paced 60-second soak | 60 | 0 | 174 ms | 60 requests/minute |
| Separate 100-session burst | 600 | 0 | 1,786 ms | 96.59 requests/s |

This follow-up passes the confirmed ten-active-user gate. The 100-session result remains reported
as additional stress evidence; it does not replace the confirmed simultaneous-user target or
erase the earlier 2,035 ms observation.

Loopback inspector samples separate the Next.js process from the harness. During the paced
ten-user soak, application RSS fell from 409 MiB to 167 MiB and heap from 187 MiB to 122 MiB; after
30 idle seconds they were 168 MiB and 111 MiB. The harness fell from 109 MiB to 66 MiB RSS. The
extra 100-session burst raised application RSS to 635 MiB, which fell to 254 MiB during the
following 30-second idle window. Inspector heap readings became unavailable after that deliberate
burst, so only RSS recovery is established for the burst. This bounded run does not prove a
long-duration plateau, Vercel memory behaviour or remote database connection headroom, but it
does show that the earlier local RSS peak was not retained under the confirmed ten-user workload.
Full evidence:
[`hundred-users-http-soak-2026-09-20.json`](benchmarks/hundred-users-http-soak-2026-09-20.json).

### Fifty-company daily-run timing and failure isolation

The guarded local drill in `apps/worker/src/fifty-company-daily-drill.ts` used the real daily-run
fan-out, three-lane task queue, Greenhouse and generic HTML adapters, scan reconciliation and scan-run finaliser
against the dedicated `christopher_50_company_release` PostgreSQL database. All responses were
private deterministic fixtures and paid-model credentials were refused.

The fixture mix comprised 40 Greenhouse sources and 10 generic HTML sources. An initial successful
run stored five open roles for each company. The measured run then
returned a controlled HTTP 500 for one company while the other 49 remained healthy. The finalised
daily run completed in **0.458 seconds** wall-clock (**0.407 seconds** by scan-run timestamps), against the SPEC's 900-second
limit. It recorded 49 successful scans and one failed scan. The failed company retained all five
open roles, closed none, and its source recorded one consecutive failure plus the exact HTTP error;
the other 49 companies completed. All 102 queue tasks across setup and measurement were terminal
`done`, because a safely recorded failed source scan is a completed queue task rather than a queue
crash.

This passes the local synthetic timing and failure-isolation check against the 900-second target
for this fixture shape. The SPEC's daily-run performance still needs representative hosted
evidence: this does not establish public-provider throughput, mixed-source accuracy, hosted
scheduling, browser memory, paid-model latency, remote database/PgBouncer behaviour or the hosted
capacity gate. Machine-readable evidence is in
[`fifty-company-daily-run-2026-09-20.json`](benchmarks/fifty-company-daily-run-2026-09-20.json).
