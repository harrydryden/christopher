# Release-gate development — 20 September 2026

## Verdict

**Not ready for production sign-off.** This follow-up implements release controls, strengthens acceptance tooling, fixes provider and live discovery/extraction defects, and adds populated capacity and recovery evidence. Local checks pass; remaining external and accuracy gates are explicit below. Missing credentials, labels and hosted configuration are never converted into successful checks.

The target confirmed by the user is **100 registered users, around ten active at once**. Harry is the operational alert owner; the agreed recovery objectives are **at most 24 hours of lost changes (RPO) and restoration within four hours (RTO)**. Astra directed the work and reviewed integration; Sol sub-agents implemented and verified bounded operations, capacity/recovery and live-acceptance work. Changes follow audit commit `f075d0d` on `codex/production-review-20260920`, based on `main` at `6a0ad4a`. No production data was changed, no live deployment performed and no merge made.

## Implemented changes

| Priority | Problem | Change and verification |
| --- | --- | --- |
| High | Haiku received an unsupported effort parameter, risking failed calls at production model sites. | Optional effort is emitted only for explicitly supported models; unknown/legacy models omit it. AI regression tests cover supported, dated and unsupported models. Compatibility was checked against Anthropic's current effort/model documentation. |
| High | HTML job extraction admitted decorated Apply controls and careers navigation as postings. ATS detection also matched provider names anywhere in a URL. | Strip terminal accessibility hints for title classification, exclude site navigation while preserving job-card content, and match ATS hostnames correctly. Reduced real-page regressions retain legitimate role controls. [Fresh public-page observations](benchmarks/html-extraction-regression-2026-09-20.json) found none of the named false positives after the fix; this is not a precision/recall claim. |
| High | Discovery could accept a careers landing page's featured jobs before following its explicit full-listing link. | Follow-up discovery handling and bounded live evidence are recorded in the live-acceptance report; exact source agreement remains separately graded. |
| Medium | Release success only proved the worker revision; missing web identity could go unnoticed. | Web health reports Vercel's commit with no-store caching. CI-triggered release jobs require both endpoints to report the exact checked commit, with bounded deadlines and explicit configuration failures. |
| Medium | There was no scheduled repository-visible operational failure check. | A fifteen-minute read-only workflow requires the expected release identity and samples worker health, failing on overdue scans, any ready task aged fifteen minutes, sustained heap/database waits, material queue growth and repeated process changes or uptime regressions. Delivery to an owner still needs configuration and proof. |
| Medium | The CV evaluator could pass negative cases on a low total score and did not correctly account for reservations/actual usage. | Validate the intended rubric, per-requirement semantics and exact inflated claim. Require a grounded, useful generated CV and PDF under two pages; record actual usage and concurrent cost holds. Missing provider access is blocked. Manual document review remains mandatory. |
| Medium | Previous capacity fixtures lacked populated CV/Library/application journeys and representative HTTP writes. | Seed populated tenant fixtures; exercise authenticated reads, CV archive/restore with page-state checks, deterministic database writes and a bounded paced workload. Separate application and harness memory readings. |
| Medium | Recovery instructions lacked a reusable executable check. | Isolated logical backup/restore validates counts, tenant fingerprints, orphan checks, constraints and migration reruns. Existing databases are never dropped. |

No dependencies or schema migrations were added. The specification's outdated six-slot deployment annotation now agrees with the three-slot worker guidance. Product requirements and their outstanding acceptance criteria remain intact.

## Executed evidence

Final verification passed: **333 core, 84 AI, 263 worker and 490 web tests**, plus **six separately enabled worker Chromium tests** and **26 native script tests** — **1,202 distinct passing tests**. All package and evaluator type checks, the production build and the authenticated Chromium journey passed. Targeted tests cover subsequent discovery/extraction changes, and native script tests run in CI alongside a new evaluator type check. The browser journey includes Library readiness and confirmation, saved CV edits, mobile layout, progress/failure recovery, application stages and archive/restore/delete, and unauthenticated review sharing.

### Capacity and recovery

| Local check | Result |
| --- | --- |
| Ten active users, 600 authenticated reads | Zero errors; p95 **203 ms** |
| Real authenticated CV archive/restore, 20 requests | Zero errors; p95 **68 ms**; page state checked after both operations |
| Paced ten-user workload, 60 requests over about one minute | Zero errors; p95 **174 ms** |
| Deterministic decision, Library and queue fixture transactions | Zero errors; p95 **14 ms**; these use SQL, not browser forms |
| Separate 100-session stress, 600 reads | Zero errors; p95 **1,786 ms**; an earlier run's **2,035 ms** miss against the proposed 2,000 ms threshold is retained |
| Local recovery drill | **1.93 seconds**; counts/fingerprints match, checked orphan count and unvalidated constraint count zero, all 34 migrations retained and rerun |

During the target paced workload the application RSS fell from 409 MiB to 167 MiB, and heap from 187 MiB to 122 MiB; post-idle readings were 168 MiB and 111 MiB. The extra burst peaked at 635 MiB RSS and recovered to 254 MiB after idle; post-burst heap telemetry was unavailable. No retained-memory defect was reproduced. A one-minute local observation does not establish long-running behaviour, hosted limits, worker Chromium headroom, serverless connection fan-out or remote-provider latency.

Evidence: [populated baseline](benchmarks/hundred-users-mixed-2026-09-20.json), [HTTP writes and paced workload](benchmarks/hundred-users-http-soak-2026-09-20.json), [recovery](benchmarks/recovery-drill-2026-09-20.json), [method and limitations](CAPACITY-AND-RECOVERY-DRILLS.md). All fixture and restored databases were preserved; the task-owned PostgreSQL containers were stopped after verification.

The read-only operational check also passed against the currently deployed base revision `6a0ad4a67da2900712efbdc5dcc0737a762e1c9e`: zero ready/running tasks and no overdue scans or sustained heap/database pressure. It does not certify the unmerged candidate.

### Provider and real-company acceptance

The 25-company observation uses actual polite fetching, discovery and adapters. It is a diagnostic sample, not an independently labelled posting-identity golden set. The initial run exposed a wrong labelled source auto-accept and false HTML postings, motivating the fixes above. A subsequent 25-case observation had eleven dated source labels, ten correct automatic resolutions, zero labelled wrong automatic acceptances, nineteen extraction completions and six failures. That observation was blocked by fourteen missing source labels and posting-identity snapshots. The subsequent gate follow-up verified all fourteen source labels and captured two independent machine-derived snapshots, exposing further false acceptances and an RSS false posting; see the dated follow-up in the live-acceptance report. Machine-derived labels are not a human-reviewed golden set. The final Wise check selected the full `/jobs` page at 0.85; this is source agreement, not recall. Follow-up evidence and coverage limitations are in [live acceptance](live-acceptance.md). Stale candidate boards and blocked sites are not counted as verified labels or hidden by relaxing safety limits.

The strengthened CV evaluation ran its preflight and correctly exited unsuccessfully with `blocked`, zero spend and `releaseAccepted: false` because no `ANTHROPIC_API_KEY` is available. The [report](benchmarks/provider-evaluation-2026-09-20.json) is evidence of a blocker, not generation success. [The evaluator instructions](CV-PROVIDER-EVALUATION.md) explain the conservative cost guardrail, provider-price provenance and required manual PDF review.

## Subsequent gate follow-up

Read-only hosting inspection confirmed the actual Frankfurt web execution, Render plans and
PgBouncer presence, the three-day PITR window, and a worker restart during concurrent company
verification. The restart is real; an out-of-memory cause remains a hypothesis rather than a
confirmed platform exit reason.

The release candidate now permits only one `verify_company` handler at a time in the persistent
worker process while preserving three general queue lanes. Eligibility checks and claims are
serialised to prevent simultaneous admission; a timed-out handler retains its reservation until
the underlying work settles. Per-task logs now include RSS as well as heap. This is a process-local
limit for the current single instance, not a distributed limit or proof of hosted capacity. The
database-backed queue suite passed **41 tests**, including unrelated-task progress, failures and
timed-out work that ignores cancellation.

Further accuracy fixes exclude RSS/subscription and careers-content destinations from posting
extraction and recognise explicit listing links such as “Find your role”. The final bounded Stripe
and Mozilla rerun automatically selected both independently labelled listings at 0.85, with zero
wrong accepts in these two cases. Exact-response replay on frozen Mozilla US and GB pages found
the same 22 posting identities, all recovered with no extras. Only that evidenced locale pair is
accepted as equivalent; other locale URLs retain strict matching. These small machine-derived
snapshots are not the full human-reviewed golden set. HTTP-only unresolved cases and the excluded
browser/AI paths remain explicit in [live acceptance](live-acceptance.md).

The core suite passed **335 tests** after these fixes. All package type checks, the evaluator type
check, **26 release-script tests**, the frozen-lockfile install and the production web build passed.
These are incremental follow-up checks; the earlier 1,202-test baseline remains separately dated.
The web package now pins Node 22.x to match those checks and CI; production still shows Node 24.x.

Harry confirmed operational ownership and RPO 24h/RTO 4h. Stable GitHub health URL variables were
set and verified. Render's inherited failure-notification setting was inspected, without sending
a test alert. A separate managed recovery copy and the missing worker health-check setting are
prepared and await approval; no deployment or production-data change has been made.

## Gates still requiring evidence

| Gate | What remains | Why it cannot be signed off here |
| --- | --- | --- |
| Hosted capacity/configuration | Run the representative workload alongside real scans in a safe production-like environment; confirm pooled endpoint use and client limits. | Read-only Render/Vercel inspection completed. Worker is 512 MiB, database is 256 MiB with PgBouncer, and actual web requests execute in Frankfurt. An unclean worker exit during parallel verification needs mitigation and a hosted repeat. See [hosted evidence](HOSTED-CAPACITY-2026-09-20.md). |
| Real discovery/extraction accuracy | Complete independent source labels and dated posting-identity snapshots; demonstrate the specification's automatic resolution, zero wrong accepts, one-confirmation recovery and Tier-1/Tier-3 precision/recall thresholds, including browser/AI cases. | The live diagnostic run lacks the independent golden denominator and paid/browser paths. No accuracy certificate is inferred from role counts. |
| Provider/CV quality | Run real generation and assessment for the intended production models, record costs and inspect the resulting PDF. | A provider credential must be configured securely outside chat; none is available to this execution. |
| Managed recovery | Restore an actual managed backup into isolation, measure time and integrity, then exercise rollback/roll-forward. | Harry confirmed RPO 24h/RTO 4h. Render shows a three-day point-in-time recovery window; an isolated managed restore is prepared, awaiting approval for the additional billed database. Retention alone does not prove either objective. |
| Operations | Prove notification delivery to Harry; cover persistent failures, provider/spend and longer-window restart history. | Both stable health URL repository variables are set and verified. Render inherits workspace failure notifications. Scheduled workflow activation still requires merge; neither notification delivery nor the missing Render `/healthz` service setting is proven/configured. |
| Live release | Review changes, run hosted CI, obtain release approval, merge/deploy, verify both exact revisions and complete an authenticated hosted journey. | The user's audit instructions require explicit approval before live deployment. Changes remain local to avoid triggering hosted preview/release automation. |

[Release controls](RELEASE-GATES.md), [deployment/recovery checklist](DEPLOY.md) and the [updated requirements matrix](PRODUCTION-REQUIREMENTS-2026-09-20.md) provide the hand-off. The original [audit report](PRODUCTION-AUDIT-2026-09-20.md) remains the record of earlier race-condition, authentication and request-bound fixes.
