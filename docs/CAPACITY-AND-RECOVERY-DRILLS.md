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
