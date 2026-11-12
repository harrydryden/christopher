# Helper and abstraction review — 12 November 2026

Baseline: main `6893adbd`. This pass examines helper ownership, duplication, caller
counts and avoidable work. It does not change product policy, provider selection,
database schema or CV prompts.

## Method and findings

An AST inventory covered 609 non-test source files and 2,688 named function
declarations across web, worker, core, database and AI packages. Exact function
bodies were compared and low-reference declarations checked against source,
tests and scripts. Counts are discovery signals, not proof that code is unused:
framework entry points, runtime hooks and public exports require manual review.
Arrow functions and semantically similar algorithms also need manual inspection;
this inventory is not a complete semantic clone detector.

| Finding | Action |
| --- | --- |
| Unrendered EmploymentHistoryTable imported solely for its removal-confirmation helper | Move the helper into existing library row operations; delete the obsolete component and its CSS module; retain its behaviour tests |
| Identical employment-entry lookup in readiness and editor operations | Reuse the existing `jobEntry` helper |
| Readiness repeatedly scans all entries to find each child's active parent | Build an active-ID set once per calculation; test active, archived and missing parents |
| Same text-selection reader in Refine and Manual | Share a DOM helper, reading selection at invocation time; return null for missing/non-input elements |
| Identical failure-duration formatting in core and AI engine | Keep one implementation in core's existing failure vocabulary; preserve distinct user and operational messages |
| Number formatters reconstructed per displayed value; schedule date formatters reconstructed per calculation | Lazily reuse native Intl number formatters and a bounded, 32-entry schedule date formatter cache |
| Uncalled `cvDraftSize`, `assertStripeCatalogue`, `topupDescription`, `ensureSeedTags` wrappers | Remove; active build estimators, launch/catalogue checks and per-account seed paths remain in place |

## Libraries and boundaries

Use the standard library's `Intl`, `Map`, `Set` and DOM selection APIs here. A new
date, memoisation or generic utility dependency would add maintenance and bundle
cost without solving a missing capability. Keep Zod for schema validation and
Drizzle for database operations; this review does not replace them with custom
implementations. The internal Intl module imports no validators, database or Node APIs.
Web clock/date formatting retains its existing implementation: sharing the cache
there added browser code without enough benefit to justify the route-budget cost. Its bounded cache stores formatter configuration only, never account data,
formatted user values or dates. Invalid options still throw; formatting always
uses the current supplied date, including across daylight-saving transitions.

Do not consolidate the following solely because their code looks similar:

- URL/IP safety parsing versus display URL normalisation: security and canonical
  presentation have different contracts.
- Evidence/skill/quote normalisation: Unicode, punctuation and identity rules
  differ, and changing them can alter saved matches or provenance.
- Retry/backoff, lease cancellation and queue interruption: each has its own
  resource and idempotency guarantees. The apparently unused discovery
  interruption helper warrants a lifecycle audit, not blind deletion or wiring.
- Web and worker telemetry bootstrap: small duplicated enablement checks avoid
  pulling runtime-specific dependencies across startup boundaries.
- One-use functions that name business rules or isolate costly branches: caller
  count alone is not a reason to inline them.

The unused opportunity-choice query is left for a separate opportunity-workflow
review rather than mixed into CV helper cleanup. No broad new `utils` module or
generic abstraction framework is introduced.

## Validation

Focused regressions cover selection freshness, parent eligibility, existing
library-edit operations, failure wording, clock precision, timezone separation,
DST/midnight transitions and bounded cache eviction. The full core suite passes 842 tests and the full AI suite passes
213 tests. Affected web helpers and editing components pass 83 tests. Production web compilation and type validation pass. Initial web
typechecking encountered stale duplicate generated `.next/types` files; the
production build regenerates those outputs without changing source contracts.
All package typechecks pass, and every production route passes its existing
bundle budget without increasing a limit. No database-backed integration suite
was rerun: database writes, schema and active queue/handler behaviour are unchanged.

A local microbenchmark of 10,000 schedule-style `formatToParts` operations measured
294.9 ms constructing a formatter per call versus 45.7 ms using bounded reuse
(about 6.5 times faster for this operation). This is one local diagnostic, not an
end-to-end latency or production throughput claim. No paid model calls or
production data changes were made.
