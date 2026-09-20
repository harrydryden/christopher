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

## Corrected source-label review and bounded rerun: 20 September 2026

The remaining fourteen source labels were checked against company-owned careers pages and their current outbound listing links. Ten stale or invalid candidate mappings were replaced with the first-party listings now presented by Airbnb, Stripe, Netflix, Datadog, Cloudflare, Automattic, Salesforce, Siemens, Revolut and Zapier. GitLab's first-party flow still resolves to its Greenhouse board, so that board remains the labelled source. Spotify, Mozilla and 37signals retained their first-party listings. Each manifest row records the dated evidence URLs.

The bounded rerun is in `live-acceptance-corrected-labels-2026-09-20.json`. It is a failing observation, not a release pass. That report predates the final GitLab label correction and records three exact automatic agreements and three wrong automatic acceptances. Applying only the corrected GitLab label to the same observations yields four agreements and two wrong automatic acceptances among the fourteen cases. A separate final-label rerun in `live-acceptance-gitlab-final-label-2026-09-20.json` confirms that GitLab resolves to the labelled Greenhouse source at 0.97. Thirteen direct extractions completed; Revolut was blocked by a 403 and remained blocked. Several completed HTML extractions returned zero or obvious navigation links, which is reachability evidence rather than accuracy evidence.

Two small permitted pages were then frozen under `live-snapshots/2026-09-20/` through the real polite fetcher. `independent-oracle.json` records hashes, source-specific posting identities and the adapter output. A source-specific enumeration found 22 unique Mozilla posting IDs, while the HTML adapter returned those 22 plus the RSS feed “Subscribe to our open positions RSS feed”: recall 100%, precision 95.65% for this snapshot. The 37signals page explicitly stated that there were no openings and both the independent enumeration and adapter returned zero. This oracle is machine-derived and independently implemented from the adapter under test; it is useful defect evidence, but it is not a human-reviewed golden label and therefore has not been copied into `expectedRoleCount` or the acceptance metrics.

The two-snapshot comparison establishes one genuine extraction defect: the generic HTML adapter admits Mozilla's careers RSS subscription as a posting. The wider corrected-label run also establishes discovery defects, but the cases require identity-level review before changing thresholds or making broader heuristic changes.

## Targeted extraction and discovery correction: 20 September 2026

The generic HTML extractor now rejects exact listing, subscription and careers-content path segments such as `feed`, `search`, `listings`, `benefits` and `locations`. It still accepts derived posting slugs such as `feed-engineer` and job-detail URLs carrying an ID query. Discovery also recognises “Find your role”, “Find your next role” and “Job listings” as explicit onward-listing links. These changes stop Stripe's and Mozilla's careers-content pages being mistaken for job listings while preserving their actual listings.

The final bounded live rerun is in `live-acceptance-stripe-mozilla-final-2026-09-20.json`. Both companies resolved automatically at 0.85 to their independently labelled current listings, with zero wrong automatic acceptances. Stripe's dated label now uses the current `/careers/search` path. Mozilla's en-US and en-GB listing snapshots contained the same 22 posting identities, so only those two reviewed URLs are explicit equivalents; locale-prefixed URLs are otherwise compared strictly.

The frozen post-fix comparison is under `live-snapshots/2026-09-20-after-fix-2/`. The adapter was run against the exact captured response rather than a second network response. It returned all 22 Mozilla postings with no RSS false positive: 100% precision and recall against the machine-derived oracle. The independently asserted 37signals empty state still agreed at zero. Diagnostic Stripe and Mozilla careers-page snapshots assert no posting oracle and therefore publish no precision or recall.

The remaining discovery misses in the fourteen-case HTTP-only rerun have different causes. Revolut's labelled page is blocked by a 403. Netflix discovery starts from a robots-restricted consumer homepage and does not reach the separate careers host. Datadog, Cloudflare, Salesforce and Siemens reach relevant careers pages but leave JavaScript-driven or landing-page candidates at confirmation confidence. Spotify is a JavaScript-driven site that the HTTP-only run did not resolve. 37signals has a valid zero-opening page, which cannot prove itself through posting links. Automattic reaches its careers flow but does not verify a complete listing through the static HTML path. These observations describe the bounded harness, which deliberately excludes the production browser and AI fallbacks; they are not evidence that the full production discovery pipeline fails those cases.
