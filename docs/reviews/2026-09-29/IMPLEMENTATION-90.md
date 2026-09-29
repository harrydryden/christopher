# Development contract — JTBD 90

The 29 September baseline remains unchanged as historical evidence. The new target is **every J1–J9 ≥90/100**, completeness ≥4.5, robustness ≥4 and UX/UI ≥4. The existing formula remains `20 × (0.3C + 0.3R + 0.4U)`; its minimum permitted dimensions yield 83, so the working target is **C=R=U=4.5** (90). Do not inflate a score to meet the requested number.

Branch: `codex/jtbd-90`, based on `ebb346b`. Astra coordinates architecture, state semantics and acceptance. Sol executes bounded changes in three workstreams, with separate local PostgreSQL databases. All integration and browser checks use disposable data.

| Workstream | Development | Acceptance focus |
|---|---|---|
| Evidence / CV | Lossless conflict recovery; source-grounded current employment; responsive single-input evidence editing; import stall clock; CV next-action guidance | No lost local writing, no invented employment status, usable mobile editing, clear build/review/finalise recovery |
| Reliability | Atomic preference merge; unresolved suspicious scan visibility; stale discovery fencing; deterministic replay test and portable fetcher test | Concurrency preserves intent, Health matches source state, tests exercise real invariants |
| Applications / companies | Due/overdue + stage working views; truthful dates; replacement-advert quote; responsive application/company items; bulk homepage entry | Urgent work reachable across pages, no fabricated date, quote matches input, simple employer setup |
| Shared experience | Outcome-based onboarding; direct Health and Learning navigation; compact phone shell; readable controls; responsive role review; active filters and retained undo | First scan status is truthful, work takes precedence over chrome, actions and context stay together |
| Evidence qualification | Fresh tests/build/browser journeys; current independent source and provider evidence where available; recovery and release policy checks; independent re-score | Distinguish implemented, demonstrated, historical and still-unverified claims |

Implementation does not itself prove live provider quality, independent source recall, real-user calibration or hosted recovery. Those remain explicit acceptance evidence; no synthetic report will be relabelled as live or human-reviewed. Production deployment and external notifications are not part of local implementation.

## Delivery checkpoint

The local development pass and independent cross-reviews are recorded in [RESCORE-90](RESCORE-90.md), with verification in [IMPLEMENTATION-VERIFICATION](IMPLEMENTATION-VERIFICATION.md). No job has yet reached 90. The ordered acceptance-and-repair programme in that report supersedes the historical 80-point roadmap.
