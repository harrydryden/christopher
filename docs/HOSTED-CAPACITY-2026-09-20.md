# Hosted capacity gate — 20 September 2026

## Verdict

**Partial; the hosted-capacity release gate is not passed.** The live Render worker and database are lightly loaded now and their measured 24-hour resource use leaves substantial headroom. The worker is running the intended three queue slots and its current database pool is idle. Render also confirms that this database has a PgBouncer connection pool, so the older generic statement that Render has no pooler does not describe this instance.

This is still not evidence that the target workload of **100 registered users and about 10 active at once** is safe. No representative hosted workload was run, the 24-hour window contains little ordinary traffic, the worker had one unclean exit while three live verification tasks were running, and Vercel function fan-out through PgBouncer has not been measured. The candidate at `dd8925d` is not deployed: live worker health reports `6a0ad4a`.

The initial inspection was read-only. The subsequently approved health-check configuration change is recorded below. It used Render's API, aggregate PostgreSQL statistics, sanitised operational logs and the public worker health endpoint. It did not read table rows, credentials or connection strings, and did not generate load or change hosted configuration.

## Authoritative hosted configuration

| Resource | Live setting | Gate implication |
| --- | --- | --- |
| Worker | `christopher-worker`, Starter, Frankfurt, one instance, Docker | One 0.5 CPU / 512 MiB process is the only persistent queue consumer. There is no instance redundancy. |
| Worker health check | `/healthz`, saved with explicit approval at 09:00 UTC | Render API confirmed the setting; configuration-triggered rollout of the existing base became live at 09:00:40 UTC and the endpoint returned HTTP 200/healthy. |
| Worker concurrency | Live boot log: 3; browser enabled; AI configured | Matches the supported small-instance setting. The code creates a pool of `2 × concurrency + 4`, therefore 10 connections at concurrency 3. |
| Database | `christopher-db`, PostgreSQL 16, Frankfurt, `basic_256mb`, 256 MiB RAM, 1 GB disk | Smallest paid database tier; disk autoscaling is off. |
| Database resilience | No HA, no read replicas | A database or plan event is an availability outage; capacity headroom is not redundancy. |
| Database pooler | Render API: `connectionPool: pgbouncer` | Pooler is present. Its mode and client-connection limit were not exposed by the inspected API and remain to be confirmed. |
| PostgreSQL settings | `max_connections=103`, `shared_buffers=64MB`, `effective_cache_size=192MB`, `work_mem=1654kB` | The 103 figure is the backend ceiling, not automatically the PgBouncer client admission limit. |
| Web | Vercel `christopher-web`; Standard 1 vCPU / 2 GB function setting, Fluid Compute enabled, Node 24.x shown in the dashboard | A production `/api/health` request received in London (`lhr1`) was routed to the Frankfurt function region (`fra1`), as required by `apps/web/vercel.json`; its execution took 126 ms and used 228 MB Fluid memory. The dashboard's `iad1` value is the overridden project default, not evidence of transatlantic production execution. Node 24 remains a runtime drift from the intended Node 22 line. |

## Last 24 hours ending 20 September 2026 08:40 UTC

Render metrics were sampled at five-minute resolution. Values are per resource; worker series are split across deploy incarnations.

| Measure | Average | Peak | Limit | Reading |
| --- | ---: | ---: | ---: | --- |
| Worker CPU | about 0.0046 CPU | 0.059 CPU | 0.5 CPU | Peak about 11.8% of the limit. |
| Worker memory | about 132–142 MB by incarnation | 297.9 MB | 536.9 MB | Peak about 55.5% of the limit. Five-minute samples can miss short spikes, including a process-ending spike. |
| Worker instances | 1 | 1 | configured 1 | No horizontal capacity or failover. |
| Database CPU | 0.0087 CPU | 0.0154 CPU | 0.1 CPU | Peak about 15.4% of the limit. |
| Database memory | 100.0 MB | 147.5 MB | 268.4 MB | Peak about 54.9% of the limit. |
| Database active connections | 1.27 | 8 | PostgreSQL backend ceiling 103 | Low observed pressure. This series does not prove the PgBouncer client limit or behaviour under Vercel fan-out. |

An aggregate point-in-time SQL sample found 17 PostgreSQL processes in `pg_stat_activity`, of which 8 were client backends; the current database reported 8 backends. State counts were 1 active, 5 idle and 9 without a client state. The worker health endpoint separately reported a two-connection application pool, both idle, none waiting, one slow query since boot, 168 MiB RSS, 45 MiB used heap of a 259 MiB heap ceiling, and no queue or scan pressure.

No HTTP 500/502/503 request logs and no error/critical/fatal application logs were returned for the window. This does not mean the lifecycle was clean. At 06:11 UTC, the worker started again and explicitly logged recovery after an unclean exit with three tasks left running. The preceding task logs show growing heap readings during a three-slot verification burst; the five-minute Render memory series did not capture a limit breach. Later replacement/deploy shutdowns were clean `SIGTERM` events. This single unclean exit is material because it occurred under real work, even though the process recovered and the current health snapshot is quiet.

### 06:11 unclean exit investigation

A narrower one-minute Render query changes the interpretation of the five-minute summary. Worker memory rose from about 152–157 MB at 06:05–06:10 to **428.2 MB at 06:11**, or **79.8% of the 512 MiB cgroup limit**. CPU reached 0.108 CPU, about 21.7% of its 0.5 CPU limit. At 06:12, after restart, memory was 101.6 MB. A sub-minute peak could therefore have crossed 512 MiB even though the one-minute sample did not.

The final workload was a continuous three-slot batch of `verify_company` tasks. The task boundary readings rose as follows:

- starts at 46 MB heap; completed tasks then reported 69 MB (+23), 75 MB (+29), 105 MB (+53) and 109 MB (+41);
- garbage collection brought reported heap back to 68–81 MB for several subsequent tasks;
- the final three `verify_company` tasks started at 69, 75 and 81 MB heap and never emitted a completion, retry or caught exception before the process disappeared;
- the replacement process started at 06:11:23 with the **same Render instance identity**, 37 MB heap and 140 MB RSS, then found three leased tasks and one AI hold from the dead process.

There was no `SIGTERM`, shutdown hand-back, JavaScript out-of-memory stack, uncaught exception, Render platform exit-code line, or deploy at that time. The next scheduled deployment was at 07:19 and produced the expected clean shutdown. The process restart is therefore unrelated to a healthy deploy or application shutdown. The available Render logs do not expose the kernel/cgroup exit code, so **cgroup OOM is the leading explanation, not a proven diagnosis**. It fits the abrupt loss, 428 MB one-minute RSS-equivalent reading, immediate memory reset and absence of an application exception. A native Chromium/process allocation would not be bounded by V8's 259 MB heap ceiling, which explains why heap task readings were only 69–109 MB while total service memory approached the container limit.

The deployed Dockerfile sets no `NODE_OPTIONS`; Node reports a 259 MB heap ceiling. Browser rendering is enabled. `BROWSER_CONCURRENCY` defaults to **1**, so this was not three simultaneous Chromium contexts, but three verification handlers can retain fetched/discovery material while one browser render runs. The last requests included pages around 1.34 MB and repeated discovery fetches. That evidence identifies the reproducible shape (three parallel verifications with browser-capable discovery), but it does not identify one deterministic leaking URL or prove a retained-memory code defect. Memory returned after prior task completions, which weighs more towards transient runtime headroom than a persistent leak.

**Least-cost mitigation:** the candidate now keeps the three general queue lanes but excludes `verify_company` from new claims while one is active, and records RSS at each task boundary. Eligibility checking, database claim and the process-local reservation are serialised so two loops cannot pass the check together; other task types remain claimable and leases are acquired only for work that can run. This bound is deliberately process-local and would need a database-backed/global limit if the worker were scaled beyond the confirmed single instance. Browser concurrency is already one, so lowering that setting cannot help. The targeted hosted acceptance remains three repetitions of the same multi-company verification batch with one-minute metrics and per-task RSS, no restart, and a peak below roughly 70% of 512 MiB (about 358 MiB). If serial verification still crosses that threshold, move the worker to a 1 GiB instance; raising V8 heap alone is inappropriate because the observed gap is mostly outside V8 and would reduce cgroup safety margin. The code protection reduces the suspected transient shape but does not prove the OOM hypothesis or pass the hosted gate before it is deployed and measured.

The queue regression suite proves that two queued verifications never run together, unrelated work continues while one is blocked, the next verification is eventually admitted, and ordinary handler failure releases the reservation. A timed-out handler that ignores its abort signal keeps the verification reservation until its underlying work actually settles, preventing the old and replacement attempts from overlapping in memory. The claim critical section also re-checks shutdown before touching the database, so a loop already waiting its turn cannot claim new work after stop begins. The focused database-backed suite passed 41 tests, and the worker type check passed.

## Connection budget

The checked-in pools are bounded:

- persistent worker: 10 connections at live concurrency 3;
- each Vercel function process: 3 connections;
- the serverless cron fallback, if it runs, creates a one-slot worker context and therefore a 6-connection pool in addition to its process database access.

At a simple ten-function-process assumption, web plus worker would request up to about 40 client connections. That is below PostgreSQL's 103 backend setting, but it is not a capacity certificate. Fluid Compute can create a different number of processes, reused processes keep pools warm, and PgBouncer decouples client connections from database backends. Render’s [connection-pooling documentation](https://render.com/docs/postgresql-connection-pooling) specifies transaction pooling on port 6432, with a default client cap of 30,000 and backend pool limits of `max_connections - 10` (93 for this database). These are documented defaults, not verification of the effective live configuration or proof that Vercel uses the pooled endpoint. Current history peaked at only 8 active database connections, so the observed workload does not exercise the proposed budget.

The release budget should reserve backend capacity for Render administration, migrations and incident access rather than plan to consume all 103. A reasonable measurement gate is: under the representative ten-active-user workload plus a real three-slot scan/CV mix, demonstrate PgBouncer clients admitted without timeout, PostgreSQL active backends below 70, worker and web pool waiting at zero in steady state, and no connection errors. The exact threshold can be tightened once PgBouncer mode and client limits are known.

## Required evidence before passing

1. **Completed after explicit approval:** Render’s service health check is `/healthz`; the API, successful configuration rollout and public HTTP 200 response confirm it. The local candidate remains undeployed.
2. Retain the verified Frankfurt Vercel function override and re-check it during the representative workload; resolve the separate Node 24 versus intended Node 22 runtime drift.
3. Confirm the effective PgBouncer limits and whether Vercel uses the pooled endpoint; the documented defaults are now recorded above. Record these alongside `max_connections=103`.
4. Run a safe production-like workload for about ten active users with populated CVs, representative writes and three worker slots performing real scan/browser work. Capture worker and database CPU/memory at one-minute or finer resolution, PgBouncer client counts, PostgreSQL backends, connection timeouts, application pool waiting and request p95/p99.
5. Reproduce the 06:11 verification shape in a controlled environment and explain the unclean exit. Treat absence of a five-minute metric limit breach as inconclusive; correlate platform lifecycle events with per-task heap/RSS and Chromium use.
6. Decide whether the single-instance worker and non-HA 256 MiB database meet the agreed availability objective. That is an availability gate even if the capacity run passes.
7. Agree the storage growth response: the signed-in database dashboard showed 14.95% of its 1 GB disk used and autoscaling disabled. A three-day PITR window is configured; the approved managed copy subsequently passed read-only integrity checks after 315.35 seconds. Full application recovery/rollback remains unproven. Harry confirmed RPO 24 hours/RTO four hours.

## Evidence boundary

Render API evidence was collected from the user-confirmed workspace `tea-da1dkajl550s73fel3og`, service `srv-dadtemou01pc73c81oq0` and database `dpg-dadte11t0dsc7380n7i0-a`. Repository evidence is from worktree commit `dd8925dc2a2c70a92720ac4ba69ded692314aa01`. The worktree already contained an unrelated modification to `apps/worker/src/live-acceptance-manifest.ts`; it was not touched.

### Migration connection safeguard

The candidate rejects known Render pooled URLs on port 6432 before acquiring the session advisory migration lock. Keep the worker (which migrates on boot) and migration runner on the direct port 5432 endpoint. Vercel request-serving functions can use the pooled endpoint. Three regression cases cover internal, external and query-parameter port URLs without connecting or exposing credentials. This safeguard does not detect every possible third-party pooler.

### Controlled Chromium follow-up

A local Docker repeat at the actual 512 MiB / 0.5 CPU limits completed all nine serial verification tasks without overlap or recorded OOM, but **failed** the agreed 70% memory-headroom gate: total cgroup memory peaked at 466.8 MiB (threshold 358.4 MiB), anonymous memory at 391.8 MiB and file memory at 57.1 MiB. The initial 511.9 MiB observation is retained separately. This is not just a Node heap measurement.

The same bounded workload at 1 GiB / 0.5 CPU passed the local headroom threshold, peaking at 411.1 MiB total cgroup memory. This supports a 1 GiB staging trial; no hosted plan was changed. Neither short local run proves a long-duration hosted soak, real-provider concurrency or Vercel/database fan-out. The production gate remains open. See [method and raw evidence](CAPACITY-AND-RECOVERY-DRILLS.md).
