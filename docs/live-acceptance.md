# Live discovery and extraction acceptance

This harness makes bounded, public, read-only requests through AVA's real polite fetcher, discovery code and ATS adapters. It does not connect to PostgreSQL or bypass sign-in or bot protection. The default run makes no paid model calls; production AI fallback is an explicit, budgeted option described below.

Run a small representative observation first:

```bash
node scripts/live-acceptance.mjs --ids anduril,openai,spotify --output docs/live-acceptance-latest.json
```

Run all 25 manifest entries only after reviewing the small run:

```bash
node scripts/live-acceptance.mjs --output docs/live-acceptance-latest.json
```

Use `--discovery-only` to omit direct extraction from the labelled source. HTTP-only runs default to three concurrent cases through one shared fetcher. Browser or AI runs default to one case at a time, matching the candidate worker's serial company-verification lane. `--concurrency 1`, `2` or `3` makes the configuration explicit; AI requires one. Concurrent browser runs remain useful stress diagnostics, but shared-browser queue time consumes each case's discovery budget. Discovery uses a 16-logical-fetch and 45-second budget checked between operations; an in-flight adapter operation and the separate extraction phase may take longer. The fetcher honours robots.txt, response-size limits, per-request timeouts, host pacing and server back-off.

Use `--browser` to attach the worker's production `BrowserRenderer` to that same discovery context. Unless `--ai` is also supplied, this remains an AI-free, database-free run. The renderer has one slot, shares the fetcher's host pacing, and asks the fetcher to enforce robots.txt before every top-level document request, including redirects. The report distinguishes browser attempts, completed renders and `robots_denied`/`browser_error` failures. The runner closes its browser in a `finally` block.

### Optional production AI fallback

With an authorised evaluation budget and `ANTHROPIC_API_KEY` supplied securely in the environment:

```bash
node scripts/live-acceptance.mjs --browser --ai --ai-max-usd 1 --discovery-only \
  --output docs/live-acceptance-serial-ai.json
```

This enables the production A1 careers-link chooser and A2 page classifier using public page inputs.
It uses the system default model unless `LIVE_ACCEPTANCE_AI_MODEL` is explicitly set. No account or
Library data is read. The report records each call's model, tokens, cost, duration, outcome and case,
along with refused reservations and uncertain holds. Missing usage from a failed call retains its
conservative reservation. The cap is a process-local admission guard using repository pricing,
not a provider-side invoice limit; a refused call means the run did not exercise unrestricted AI
fallback. Keep cumulative spend across separate runs within the owner's authorised budget.

## Reading the report

`sourceMatchesLabel` is scored only where `labelStatus` is `source_independently_checked`. Entries marked `unverified` are useful coverage candidates but contribute to no accuracy claim. `expectedRoleCount: null` means nobody has hand-counted a dated source snapshot. Consequently extraction count accuracy remains `null`; an observed adapter count alone is not independent truth and cannot establish recall or precision.

The report can establish current reachability, discovery outcomes, source agreement, adapter completion or partial/failure behaviour, observed role counts and representative samples. It cannot certify the SPEC golden-set thresholds until a reviewer independently checks every source and records exact postings from frozen, dated snapshots. Browser and AI coverage depend on the options and actual calls recorded in that run. Detail-description accuracy and hosted production capacity are separate checks.

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

## Bounded production-browser observations: 20 September 2026

`live-acceptance-browser-bounded-2026-09-20.json` ran Spotify, Datadog, Automattic and 37signals with the production renderer available, plus Anduril as an ATS control. None of the four HTML cases reached the production discovery branch that renders a failed homepage or detected JavaScript shell, so there were zero browser attempts. Anduril resolved to its labelled Greenhouse board; Datadog reached its labelled page at confirmation confidence; Automattic reached the careers landing page rather than the labelled jobs page; Spotify and 37signals remained unresolved. This preserves the failures and demonstrates that merely enabling a renderer does not make the production algorithm invoke it.

The first Netflix probe exposed a safety defect: an HTTP robots denial was treated as a generic failed homepage and discovery then attempted a browser render. That attempt was interrupted. The renderer now checks the same `PoliteFetcher` robots policy before every main-frame document request, including redirect targets, while its existing host-delay reservation remains in place. `live-acceptance-browser-netflix-guarded-2026-09-20.json` is the bounded post-fix evidence: discovery attempted the fallback, the browser guard recorded `robots_denied`, no page was rendered, and the original unresolved failure was preserved.

Redirect protection is covered by a real Chromium regression against a local HTTP server. Both a server-side 302 and a later JavaScript navigation are allowed to start, then redirected to a denied path. Chromium's document-request interceptor checks the destination before sending it, and the server records zero requests to the denied path. Service workers are disabled in these short-lived render contexts so they cannot create a separate navigation path. All seven browser integration tests pass with Chromium enabled.

`live-acceptance-browser-render-37signals-2026-09-20.json` records one permitted successful production-renderer observation: robots allowed `https://37signals.com/jobs`, Chromium returned HTTP 200 and 13,470 bytes, and the rendered page retained its explicit no-openings state. The separate OpenAI discovery report resolved the correct labelled listing at 0.85, but made zero browser attempts because static discovery was sufficient. These are reachability and safety checks; broader discovery accuracy and human-labelled posting precision/recall remain unproven.

The frozen identity evidence remains separate from these live discovery reports. `live-snapshots/2026-09-20-after-fix-2/independent-oracle.json` compares source-specific identities with adapter output: Mozilla en-US and en-GB each have 22 true positives, no false positives and no false negatives; 37signals has an independently asserted explicit empty state. Those figures are machine-derived checks, not human labels, so the acceptance report correctly leaves `postingIdentityRecall` and `postingIdentityPrecision` null and does not claim the SPEC threshold has passed.

## Broader frozen extraction oracle: 20 September 2026

`extraction-accuracy-2026-09-20.md` and `live-snapshots/2026-09-20-extraction-accuracy/extraction-accuracy-report.json` extend the independent frozen-response comparison to six sources: Greenhouse, Lever, Ashby, SmartRecruiters offset pagination, populated HTML and an explicit HTML empty state. The capture uses the production polite fetcher; each complete raw response has request/final URL, method, status, capture time, byte-preserving body and SHA-256 provenance. Production adapters then receive only those frozen responses.

The independent source-specific enumerators found 2,419 posting identities. Adapter identity precision and recall were both 100%, but exact title/location/URL field comparison found 22 errors: Mozilla's HTML extraction appended the department cell to every location. Aggregate exact field accuracy was 99.70%, and Mozilla's was 66.67%. This is concrete defect evidence rather than a role-count-only pass.

The oracle is machine-derived and independently implemented, not human-reviewed. It does not alter the acceptance manifest or its labels and does not establish the SPEC threshold. In particular, four ATS types and two HTML sources remain short of the golden-set composition of at least eight ATS types and five custom HTML pages.

The generic HTML location extraction was subsequently corrected. A no-network replay against the same response hashes is in `live-snapshots/2026-09-20-extraction-accuracy-after-fix/extraction-accuracy-report.json`: all 2,419 identities remain true positives, with no false positives, false negatives or title/location/URL mismatches. The pre-fix report is retained separately rather than rewritten.
