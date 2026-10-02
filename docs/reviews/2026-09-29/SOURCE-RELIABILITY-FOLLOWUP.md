# Source reliability development and qualification follow-up

This checkpoint continues the 90-point development programme after `67fb2a5`. **The target is not yet achieved.** Astra directed the source-identity, completeness and evidence model; Sol implemented discovery and worker changes and independently challenged the final diff. The original review and earlier observations remain historical. No production deployment, external notification or paid model request was made.

## What users gain

Monitoring must distinguish “no jobs”, “some jobs found” and “all supported pages read”. Previously, JavaScript shells and missed pagination could be treated as complete; cached first pages could hide changes elsewhere in a listing. These failures undermine the user's ability to trust an empty result or a closed role, regardless of how clear the interface looks.

| Defect | Development | User consequence |
|---|---|---|
| Framework bundles consumed the discovery budget before useful careers paths; full-listing links competed with culture/team pages | Prioritise explicit full-listing links and bounded company paths; retain the originally submitted company origin after a subdomain redirect | More useful destinations are reached; an unverified destination remains a confirmation candidate |
| A probed company URL redirected to another domain and inherited automatic confidence | Carry probe provenance through nested navigation, empty-page results and rendered network ATS observations | Another site's plausible board or empty state cannot silently become the company's accepted source |
| Siemens `/JobDetail/…` links were unrecognised; its accessible Next label was missed | Recognise job-detail path variants and explicit Next labels while retaining query parameters | Actual roles are read and the six-job first page is no longer represented as the whole board |
| Careers articles and composite card text looked like jobs | Exclude specific informational destinations/CTAs and prefer a card's semantic title | Cleaner role titles and fewer irrelevant “jobs”; legitimate Learning, Rewards and Policy roles remain covered by regression tests |
| A first HTTP response was used to reuse an entire rendered or paged listing | Remove seven-day rendered-list reuse; require an explicit single-response adapter capability for whole-listing reuse | Changes on later pages and secondary indexes are read even when page one is unchanged |
| Initial loading captures, hidden head pagination and cross-origin continuation were mishandled | Continue past an initial unverified shell only when later captures establish real content; retain advertised same-origin next pages; mark unsupported cross-origin continuation incomplete | Useful partial results survive; incomplete observations cannot close missing roles |

Only Ashby, JSON-LD and RSS opt into the single-response cache capability. This describes what those adapters read, not independently proven whole-site coverage. Greenhouse rereads its departments/offices indexes; paged adapters such as SmartRecruiters do not qualify for whole-listing reuse. Per-request conditional HTTP caching remains available.

## Evidence, not a replacement for acceptance

The diagnostic now traverses HTML HTTP/browser listings, rejects unverified zero results and reports partial traversal explicitly. Extraction starts from the labelled source; it is deliberately separate from discovery. It does not exercise production persistence, learned extraction recipes or AI recovery. Worker database regressions cover those persistence and closure boundaries separately.

The new posting comparator measures exact unique URL identities, preserving meaningful query parameters. A snapshot must be bound to the labelled source, recent, accompanied by hash-verified raw evidence, independently human-reviewed and attested as full scope before it contributes to qualification. Machine API enumerations produce useful diagnostic comparisons but cannot supply that attestation. A selected subset cannot qualify the required 25-case corpus. Equal counts with different job identities fail.

The [source-label audit](SOURCE-LABEL-AUDIT.md) records independent first-party navigation checks and two public API snapshots. Netflix's expected source was corrected from its landing page to the linked Eightfold listing after separate orchestration review. That is a label correction, not a discovery improvement; prior observations are preserved.

### Bounded observations

- [Three-case follow-up](implementation-evidence/source-followup-live.json): Datadog yielded 190 of 436 separately enumerated API identities and remained **partial**; 37signals yielded an explicitly verified empty listing; Zapier yielded 13 links, comprising its 10 API-listed jobs and three informational links.
- [Precision recheck](implementation-evidence/source-precision-recheck.json): after the informational-link repair, Zapier yielded exactly those 10 API identities, diagnostic recall/precision 100%/100%. This remains machine-referenced evidence, not a full human-reviewed acceptance pass. The same run's “complete six” Siemens result was subsequently disproved by direct pagination inspection.
- [Siemens DOM observation](implementation-evidence/source-audit/siemens-pagination-observation.json): the first page explicitly said “1 - 6 of 999+ results” and linked page two. This justified the pagination repair and invalidates any interpretation of the earlier six-role observation as complete. The bounded traversal may still stop before the whole board; such a result must remain partial.

### Whole-corpus diagnostic

The [25-case follow-up](implementation-evidence/source-full-followup-live.json), completed at **14:07 UTC**, failed: **15/25 correct automatic source selections (60%)**, 19 source matches including confirmation candidates, one labelled wrong automatic selection, 17 extraction completions, six partial observations and two failures. Independent qualifying posting labels remain **0/25**. This run began before the final cross-review hardening described above; it is a dated diagnostic of that intermediate revision, not exact-final-commit acceptance.

| Case | Observation | Remaining issue |
|---|---|---|
| Stripe | Partial, 154 unique posting URLs | Browser traversal did not establish completeness |
| OpenAI | HTTP 403 | Listing access refused; no full extraction established |
| Datadog | Partial, 190 URLs; 189 matched the earlier 436-URL API snapshot | Diagnostic recall 43.35%, precision 99.47%; dated snapshots can change, and full site scope is unreviewed |
| Cloudflare | Partial, 225 URLs | Browser traversal did not establish completeness |
| Salesforce | Partial, zero verified URLs; browser HTTP 403 | Source selection and extraction remain unresolved |
| Siemens | Partial, 120 URLs | Reached the 20-page limit with more pages to read |
| Spotify | Confirmation-only Lever candidate instead of the labelled first-party listing; partial extraction | Company listing scope and browser extraction unresolved |
| Mozilla | Careers root automatically selected instead of the labelled listings page | Requires source identity investigation; the run counts it as a wrong automatic selection |
| Revolut | HTTP 403 | Listing access refused |
| Zapier | 10 URLs; exact match to the separately captured 10-URL API snapshot | Successful bounded repair; human scope/quality qualification still absent |

A “complete” entry elsewhere means the adapter or traversal stopped normally, not that independent evidence proves all and only genuine jobs were found. Large or suspiciously small listings still need posting-identity review. In particular, no overall posting recall is inferred from the 17 completion flags.

Subsequent first-party inspection disproved two of those completion claims: Wise advertised 408 results while the diagnostic returned 12; Netflix's embedded listing data advertised 475 while the adapter returned 50. Mozilla's automatically selected careers root contained three editorial blog cards and a separate “Job Listings” link. These observations prompted another repair pass; they are not explained away as label mismatches or counted as successful jobs.

### Rechecks after those repairs

- **Mozilla:** recognising the generic “Job Listings” label now follows the genuine destination. The [final two-case recheck](implementation-evidence/source-wise-mozilla-final.json) automatically selected `/en-GB/careers/listings/` at 0.85 and extracted 27 unique posting URLs. The former careers-root selection is repaired in this bounded observation.
- **Netflix:** the [independent API metadata probe](implementation-evidence/netflix-eightfold-pagination.json) proved that requesting 100 returns **10**, with a reported total of 475. The old adapter advanced by 100 and skipped rows. It now advances by actual returned rows and refuses completeness on missing/malformed structure, duplicate or invalid rows, inconsistent totals and exhausted bounds. The [final live recheck](implementation-evidence/source-netflix-final.json) extracted **475 unique roles**. Discovery still requires confirmation at 0.7; no independent human posting label was supplied.
- **Wise:** the [recorded page control](implementation-evidence/source-audit/wise-pagination-observation.json) is a JavaScript link labelled “Next pagination page”. Core detection and the browser now recognise that control; the real browser fixture advances correctly. **The actual Wise recheck still yielded only 12 roles**, now correctly labelled **partial** because an active expansion control remained. Further investigation of why the live control does not advance is required; fixture success is not substituted for site success.

These selected rechecks do not replace or mathematically revise the whole-corpus result. The full 25-case gate has not been re-qualified after the final repairs. Both selected reports refuse acceptance because corpus coverage and independent posting labels are missing.

## Verification

- Full core suite after the final changes: **684 passed**, 40 files.
- Full worker suite with disposable PostgreSQL and real Chromium enabled: **683 passed**, 53 files, no skipped tests. This run precedes the final Mozilla/Wise/Eightfold repair; final core tests, **15/15 real browser tests** and **37/37 acceptance/comparison tests** cover those later changes. These overlapping counts must not be added together as independent tests.
- The full worker run includes database regressions for unchanged first pages with changed later pages/indexes, repeated partial scans preserving old roles, initial shells followed by loaded jobs, lost later captures, head-link pagination, cross-origin continuation and mocked-model recovery. No paid model was used.
- All package type checks and the clean production build passed. A late local check found duplicated generated `.next/types/* 2.ts` files; clearing only the ignored build cache and rebuilding resolved it. [Verification metadata](implementation-evidence/source-verification.json) records the source hashes, commands and separate run scopes; [core](implementation-evidence/source-core.log), [harness](implementation-evidence/source-harness.log), [type-check](implementation-evidence/source-types.log) and [build](implementation-evidence/source-build.log) logs are retained.
- The first integrated attempt used the wrong database environment variable and failed against unavailable port 5432. It also exposed the macOS-only second-loopback fixture issue. Both were corrected before the passing 683-test run; neither failed run is counted as a pass.

No new human usability session, live paid-model quality evaluation, hosted deployment, alert delivery or managed restore was performed. The earlier UI/browser evidence remains in [IMPLEMENTATION-VERIFICATION](IMPLEMENTATION-VERIFICATION.md). Public-source raw browser logs are kept outside the repository; the committed JSON contains the scoped observations and references.

## Re-score and next development

The [scorecard and ordered roadmap](RESCORE-90.md) remain the governing assessment. No score rises at this checkpoint: J1 **83**, J2 **77**, J3 **85**, J4 **83**, J5 **85**, J6 **85**, J7 **80**, J8 **83**, J9 **67**. Independent review lowers J2 completeness from 4.5 to **4**, retaining robustness **3.5** and UX/UI **4**: the observed coverage disproves the earlier completeness judgement, despite the repairs. Its readiness therefore changes from 80 to 77 under the unchanged formula. This is an evidence correction, not an assertion that the implementation became worse. The canonical mean is **83.0** and the nine-job mean **80.9**; neither substitutes for every job meeting its target. Source coverage and independent qualification remain inadequate to certify J2 or the wider product at 90.

Next, use the remaining live failures to separate source selection, browser limits, request refusal and extraction errors. Large listings need a measured completeness strategy within the worker's request/time budgets; merely raising caps or treating a bounded sample as complete is insufficient. Establish independent posting labels, then measure supported-source recall/precision and manual-resolution task success. In parallel, complete current provider replay, real-user UX sessions and genuine learning calibration from the main roadmap. [Operational evidence](OPS-CURRENT-EVIDENCE.md) remains an earlier read-only GitHub snapshot; hosted service checks await workspace confirmation and do not qualify this local candidate.

| Next source-development order | Concrete work | Required exit evidence |
|---|---|---|
| 1 | Diagnose the actual Wise control's failure to advance: browser visibility, navigation, request outcome and changed listing identities. Preserve the explicit partial state throughout. | More than page one read on the real site; all pages or a truthful bounded partial result; repeated partial observations never close roles |
| 2 | Design bounded continuation for large listings, starting with Siemens and the Datadog/Cloudflare/Stripe browser limits. Consider verified structured feeds where first-party evidence establishes scope; otherwise persist traversal progress and only permit closure after a complete observation. | Independent identity recall/precision at the existing tier thresholds; interruption/resume and changing-listing tests; measured memory, request and daily-run budgets |
| 3 | Resolve the remaining source-selection and access cases, including Spotify and Salesforce, and define the supported/manual path for denied requests. Keep confirmation and unavailable states actionable for ordinary users. | Zero wrong automatic accepts; ≥80% correct automatic discovery; remaining supported cases resolve with one understandable confirmation/paste; no claim that a blocked request means an empty board |
| 4 | Freeze fresh independent posting snapshots and rerun the entire required corpus on the final candidate. Exercise setup → follow → scan → role review and error recovery in the actual interface. | Every required case present, human scope attestation and raw evidence retained, per-source thresholds passed, no synthetic or subset qualification |

This source programme directly addresses J2 and supports J1/J8. It does not replace the separate CV quality, real-user UX, learning and hosted continuity work required for the other jobs to reach 90.
