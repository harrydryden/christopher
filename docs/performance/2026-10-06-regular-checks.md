# Regular performance checks, 6 October 2026

Issues: [capacity #103](https://github.com/harrydryden/christopher/issues/103) and [performance #104](https://github.com/harrydryden/christopher/issues/104).

The failed scheduled runs measured b17e588. Their artefacts show no HTTP failures. The ten-user read p95 was 458ms (steady soak 305ms), but the hundred-user burst reached 2943ms against 2000ms. These local single-process measurements do not establish hosted capacity.

## Corrections

The capacity fixture previously completed scans without updating the data fingerprint consumed by the Roles poller, yet demanded refreshes. An unchanged scan should not trigger a Roles render. The probe now separates unchanged and visible-change scenarios, and repeats the hundred-user burst. Its latency thresholds remain unchanged.

Billing summaries now share a React request-scoped cache across the server layout and page. Company entitlements reuse that summary; explicit transaction writers and activation checks still read directly. Independent account and balance reads run in parallel. There is no cross-request balance cache.

## Measured performance audit

A production build on 6 October was measured using the full default `scripts/perf/run.mjs` audit, in the isolated local `ava_perf_check_20261006` database (100-account fixture, eight samples, two latency passes, five decisions). The initial comparison failed against the old baseline. Replaying that same report against the reviewed baseline passes. The subsequent full [GitHub audit](https://github.com/harrydryden/christopher/actions/runs/37478915053) also passed with the reviewed baseline. It confirmed Companies 15, Suggestions 12, Account 7 and Applications 9 statements; Learning/Health measured 3.7 round trips each.

| Route | Scheduled SQL count | After optimisation | Original baseline |
|---|---:|---:|---:|
| Companies | 17 | 15 | 14 |
| Suggestions | 14 | 12 | 11 |
| Account | 9 | 7 | 6 |
| Applications | 11 | 9 | 18 |
| Library | 13 | 13 | 12 |
| CV | 14 | 14 | 13 |
| Settings | 10 | 10 | 8 |
| Learning | 14 | 14 | 12 |
| Health | 17 | 17 | 12 |

The original one-statement, one-round-trip and 10% payload tolerances are unchanged. Query baselines include improvements (Roles 14→13 and Applications 18→9), rather than retaining obsolete headroom.

Retained changes are attributable to features introduced since the original audit:

- The shared plan/credit readout adds billing reads throughout authenticated pages; duplicate page reads have been removed.
- Companies/Suggestions include company-capacity information. Companies also renders richer responsive company management and monitoring states. Its RSC allowance becomes 115313 bytes (115336 for the discover URL).
- Account adds plan, credits and purchase controls: 9865 compressed HTML bytes and 24530 RSC bytes.
- Applications adds CV credit, recovery and application workflow controls: 14058 compressed HTML bytes, while SQL drops to nine statements.
- Library/CV include the credit readout and expanded editing/recovery workflow. Library HTML becomes 12885 bytes.
- Suggestions includes capacity guidance: 8605 compressed HTML bytes.
- Settings includes shared plan reads. Learning includes draft/tag history and profile comparison recovery. Health includes resumable listing scan progress and location checks: 7761 compressed HTML bytes.
- Learning and Health each measured 3.8 effective round trips in the scheduled artefact, versus original baselines of 2.9/2.8. Their retained baseline is 3.8, allowing the existing one-wave tolerance; the local measurements were 4.6/4.5. Other round-trip baselines remain unchanged.
- The decision baseline moves from 29 to 32 statements, including the current recovery/queue protections and re-rendered shared shell; it still uses one HTTP request and its measured response fell from the original 92856 bytes to 57636.

No baseline increases excuse the hundred-user latency failure; the capacity probe must independently meet its existing 2000ms target.

## Local capacity replay

The full default-shape local run completed with no request errors. Its three burst p95 samples were 1373/2131/1604ms. The second sample exceeded the unchanged 2000ms gate. The unchanged polling phase also failed its route p95 gates (work status 2002ms, scan status 1692ms); its medians were 13/15ms. The busier changed phase passed with 290 follow-up renders. Host free-memory samples were very low, so host contention is plausible but not established. The local report remains a failure; no thresholds were increased.

The fixture behaviour is verified: four unchanged scans produced zero visible changes and zero refreshes. The mixed-change phase completed four scans, changed three visible roles (the explicit first-three-of-four schedule), and produced 2.91 refreshes per tab per minute, within the existing 2.3–3.3 range.
