# Live discovery and extraction acceptance

This harness makes bounded, public, read-only requests through Christopher's real polite fetcher, discovery code and ATS adapters. It does not connect to PostgreSQL, call a paid model, use credentials, or bypass sign-in or bot protection.

Run a small representative observation first:

```bash
node scripts/live-acceptance.mjs --ids anduril,openai,spotify --output docs/live-acceptance-latest.json
```

Run all 25 manifest entries only after reviewing the small run:

```bash
node scripts/live-acceptance.mjs --output docs/live-acceptance-latest.json
```

Use `--discovery-only` to omit direct extraction from the labelled source. Up to three cases run concurrently through one shared fetcher, preserving host pacing. Discovery uses a 16-logical-fetch and 45-second budget checked between operations; an in-flight adapter operation and the separate extraction phase may take longer. The fetcher honours robots.txt, response-size limits, per-request timeouts, host pacing and server back-off.

## Reading the report

`sourceMatchesLabel` is scored only where `labelStatus` is `source_independently_checked`. Entries marked `unverified` are useful coverage candidates but contribute to no accuracy claim. `expectedRoleCount: null` means nobody has hand-counted a dated source snapshot. Consequently extraction count accuracy remains `null`; an observed adapter count alone is not independent truth and cannot establish recall or precision.

The report can establish current reachability, discovery outcomes, source agreement, adapter completion or partial/failure behaviour, observed role counts and representative samples. It cannot certify the SPEC golden-set thresholds until a reviewer independently checks every source and records exact postings from frozen, dated snapshots. It also does not cover browser-only discovery, AI fallback, detail-description accuracy, or production capacity.

To promote this into golden-set evidence, save the raw permitted pages/feeds as dated fixtures, manually enumerate posting identities outside the adapter under test, update each manifest entry with that count and review note, and then calculate recall and precision from identities rather than count equality alone.

## Executed observations: 20 September 2026

Two bounded cases were executed from a local checkout with no database or AI credentials:

- Anduril discovery resolved automatically at 0.98 to the independently documented Greenhouse board. Discovery reported one logical fetch in 37.2 seconds; adapter verification can make several paced HTTP requests within that operation. This is one labelled agreement, not an 80% golden-set result; extraction was intentionally omitted in this discovery-only run.
- OpenAI discovery resolved at 0.85 to `https://openai.com/careers/search/` as a generic HTML source after 13 logical fetches in 24.9 seconds. The manifest's Ashby URL was already marked unverified and appears stale. Direct extraction through that candidate failed safely because its response exceeded the fetcher's 5 MB request limit. This is a blocker observation, not a source mismatch or extraction-accuracy failure against a label.

The initial machine-readable evidence is in `live-acceptance-anduril-2026-09-20.json` and `live-acceptance-sample-2026-09-20.json`. The stale OpenAI Ashby candidate in that first sample was corrected to the first-party listing before the full run.

The bounded 25-case run is in `live-acceptance-full-2026-09-20.json`. Eleven source labels had dated first-party evidence: ten resolved automatically to the labelled source, while OpenAI fell back to its careers landing page at confirmation confidence after a 403 on the full search page. There were no labelled wrong automatic acceptances. Nineteen expected-source extractions completed and six failed: stale Netflix, Automattic, Revolut and Zapier candidates; an invalid Siemens Workday candidate; and the transient OpenAI 403. The run is `blocked`, not passed: fourteen source labels remain unverified, no case has an independent posting-identity snapshot, recall and precision are unmeasured, and six extractions failed.

The run exposed a generic discovery defect on Wise: its homepage contains featured roles and an explicit all-jobs link, but discovery preferred the featured subset. Discovery now follows explicit same-domain complete-listing links, prefers the verified full listing, and holds featured cards at confirmation confidence if the full listing cannot be verified. The post-fix live evidence in `live-acceptance-wise-after-fix-2026-09-20.json` resolved `https://wise.jobs/jobs` at 0.85 with no wrong automatic acceptance; its observed count of 12 is not treated as recall evidence.

A separate post-extractor read-only check fetched OpenAI and Mozilla sequentially through the polite fetcher. OpenAI returned 818 job links from 2,647,991 bytes and Mozilla returned 23 from 47,356 bytes; the named false positives “Apply now”, “Overview”, “Diversity and Inclusion” and “Benefits” were absent. This narrow check establishes regression behaviour only, not posting-level precision or recall.
