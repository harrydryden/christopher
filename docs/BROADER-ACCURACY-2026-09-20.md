# Broader discovery and CV accuracy — 20 September 2026

This review uses Astra for orchestration, diagnosis and adjudication, with Sol agents implementing and running the bounded workstreams. It extends the local candidate at `99c0edd`; it is not a production deployment or release approval. Public-source captures and synthetic provider evaluations do not use application accounts or production data.

## Findings and fixes

- A careers homepage could win over its explicit full vacancy list, and HTML linking to a single ATS board could win over the preferred board. Discovery now recognises additional complete-list wording, rejects filtered links as completeness evidence and holds ATS-backed HTML at confirmation until the preferred board verifies.
- Careers pages with substantial navigation were missed by the narrow JavaScript-shell heuristic. The browser fallback now considers the selected candidate's careers path and page content within the existing request and duration limits.
- A narrowly scoped, explicit no-openings statement can establish an empty listing. Filtered, archived, navigation and footer statements cannot. Daily scanning uses the same predicate and retains the successful-scan and two-miss closure safeguards.
- Mozilla's HTML location extraction merged location and department. Explicit posting fields now take priority over flattened card text.
- An AI extraction found all Mozilla roles but invented CSS classes for its reusable recipe. Compact input now includes bounded selectors and field text observed in the actual DOM. Full table headers and cell values preserve multi-country locations and team names that short context snippets omitted. A clipped representation is reported explicitly; worker scans preserve partial status through rendered captures and do not save recipes from clipped input. A model omission of a previously cached posting URL that remains visible also marks the scan partial. This is a bounded omission safeguard, not a proof against every possible extraction omission.
- Recipe validation now checks precision and agreement of titles, locations and departments, as well as recall. A broad selector that captures navigation, or correct links with corrupted fields, cannot become a reusable recipe.
- CV assessment awarded partial credit for observing deployments and compiling cost reports when the requirements asked for hands-on deployment and delivered savings. The review prompt now distinguishes evidence of performing or changing something from exposure and baseline activity. Preparing reports alone cannot demonstrate improving reporting.

## Evidence and its limits

The independent frozen-source comparison covers 2,419 posting identities across Greenhouse, Lever, Ashby, SmartRecruiters and two custom HTML pages. After the location fix, production adapters match every labelled identity, title, location and URL. See [the extraction report](extraction-accuracy-2026-09-20.md). These are independently implemented, machine-derived labels; they do not certify that the source-specific enumeration omitted no other posting shape.

The seven synthetic A1/A2/A3 provider checks passed, including hostile page instructions. The saved A2 confidence values are each 0.9, exceeding the now-explicit 0.85 evaluation floor. These are capability checks, not the required 40-homepage or 15-HTML-page evaluation sets.

The final [frozen A3 provider report](benchmarks/extraction-ai-complete-fields-2026-09-20.json) matches all 22 independently enumerated Mozilla identities and all labelled titles and locations, preserves the visible departments and produces a field-consistent recipe with 100% coverage. Location comparison trims whitespace around comma-separated tokens only; the report retains 13 raw formatting differences and does not discard countries, change their order or equate different names. Its 19,906-character input is untruncated. Department agreement is model-to-rendered-recipe evidence, not an independent human department label. Earlier identity-only passes were regraded and preserved as failures when field omissions emerged.

CV evaluation now exercises the production grouping, allocation, refitting, PDF rendering and assessment path. Seven synthetic cases cover senior multi-role evidence, a sparse career change, negation, invented metrics and transferred ownership, malicious instructions, a long document and exact qualifications with structured skills. Each case has independently specified requirement outcomes, retained-entry checks and page limits; adversarial claim checks identify the exact false assertion. Lexical warnings prompt visual/source review rather than treating an honest negation as fabrication.

Historical failed reports remain intact. Two label corrections are distinct from production fixes: mentoring an intern can provide partial people-development evidence, and reviewing suppliers can provide partial supplier-management evidence. Neither correction permits unsupported full credit. The improvement and savings failures instead required production prompt changes.

## Remaining release gates

- Discovery must reach at least 80% correct automatic resolution with zero wrong automatic acceptances on the full required golden set. A selected subset cannot establish that result.
- Golden coverage still needs at least eight ATS types, five custom HTML pages, two JavaScript-heavy pages and two multi-region Workday enterprises, with independent human-reviewed posting labels. The current six-source extraction comparison falls short.
- The 40-homepage A1/A2 and 15-page A3 labelled evaluations remain incomplete. Identity agreement and threshold recall are not proof of a complete observation suitable for closing jobs.
- Synthetic CV passes are useful regression evidence, not population-wide accuracy or a substitute for review of a user's factual evidence.
- Hosted rollout, capacity, operational soak and recovery gates recorded in the production review remain separate and are not closed by this work.

## Full discovery outcome

The [final 25-company browser run](live-acceptance-browser-full-final-2026-09-20.json) recorded 16 source matches, of which 15 resolved automatically at confidence ≥0.85. There were **zero wrong automatic acceptances**, down from two in the preserved initial run. Correct automatic resolution is **60%, below the required 80%**. The discovery gate therefore remains failed.

Airbnb now resolves to its labelled `/positions/` listing. Render's HTML source is held for confirmation when the preferred ATS board cannot verify, rather than being automatically accepted as the wrong source. Datadog and Automattic passed in a selected low-concurrency check but fell back to confirmation in the full run; the full-run result takes precedence and exposes sensitivity to the existing browser/time budgets. The remaining mismatches are OpenAI, Netflix, Datadog, Automattic, Salesforce, Siemens, Spotify, Revolut and Render. The final report retains browser attempts and robots failures, without changing crawl permissions or budgets to manufacture a pass.

This full run intentionally measured discovery only with production browser fallback and AI disabled. Extraction metrics in that report are unmeasured, not passes; the six-source frozen comparison is separate evidence. The next accuracy work is to diagnose these remaining source-navigation and verification failures, repeat the full cohort and expand independent golden-set coverage. A pasted URL or confirmation must also be verified end to end before claiming the 100% assisted-resolution criterion.

## CV outcome and validation

The [final CV composite](benchmarks/cv-broader-all-final-composite-2026-09-20.json) passes all seven synthetic cases. Astra visually inspected all seven selected PDFs across eight pages for factual grounding, retained roles and qualifications, clipping and overlap. The composite combines unchanged-prompt results from three source reports after conservative concurrent-call budget reservations interrupted a repeat run. The older long-document source has execution-history provenance but no embedded prompt hash; that limitation is recorded explicitly rather than retroactively inventing a hash. Original semantic failures and budget interruptions remain intact.

Validation on the final code: 352 core tests, 84 AI tests, 286 worker tests and 40 release/evaluation tests passed (762 total), with workspace and evaluator type checks and the production build passing. Worker database tests used only the dedicated local audit database.

Unique provider-call estimates for this review total $5.098823: CV $4.952860 and discovery/extraction $0.145963. Including $0.927517 from the earlier evaluation, the recorded cumulative estimate is $6.026340 within the original estimated $10 envelope. [The cost ledger](benchmarks/broader-accuracy-costs-2026-09-20.json) names each unique paid report and excludes copied reports and zero-cost regrades. These are token-based estimates, not an invoice or exact billing guarantee.
