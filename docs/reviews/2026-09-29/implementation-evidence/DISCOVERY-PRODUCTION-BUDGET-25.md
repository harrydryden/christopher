# Production-budget discovery-only corpus, 29 September 2026

One serial read-only run of all 25 independently source-labelled manifest cases started at 15:40:28 UTC and finished at 15:50:31 UTC. Browser fallback was enabled; AI and extraction were disabled. The diagnostic user-agent identity `ava-source-diagnostic@example.invalid` is not a production contact configuration. The fetcher and browser kept their robots and host-pacing protections. No expected source label was changed from the observed output.

Exact command, from the repository root:

```sh
CONTACT_EMAIL='ava-source-diagnostic@example.invalid' pnpm --filter @ava/worker exec tsx src/live-acceptance-cli.ts --discovery-only --browser --discovery-budget production --concurrency 1 --output '/Users/h_dryden/Documents/New project/christopher-jtbd-review/docs/reviews/2026-09-29/implementation-evidence/discovery-production-budget-25.json'
```

The [machine-readable report](discovery-production-budget-25.json) records each case’s expected and observed source, method, evidence, confidence, 40-fetch/120-second crawl limits, fetch and verification counts, browser attempts, failures and duration. It also records the manifest labels and the aggregate verdict. The command exited 1 because the qualified source gate failed; output was written successfully. `productionShape` in the report describes serial case concurrency only.

| Case | Outcome | Observed source | Confidence / method | Label match | Fetches; browser renders | Duration |
|---|---|---|---|---|---:|---:|
| anduril | resolved | `https://job-boards.greenhouse.io/andurilindustries` | 0.98 / verified_catalogue | yes | 0; 0 | 0.4 s |
| airbnb | resolved | `https://careers.airbnb.com/positions/` | 0.85 / listing_html | yes | 6; 0 | 25.5 s |
| stripe | resolved | `https://stripe.com/careers/search` | 0.85 / listing_html | yes | 6; 0 | 18.0 s |
| openai | not_found | `—` | — / — | no | 40; 1 | 96.1 s |
| notion | resolved | `https://jobs.ashbyhq.com/notion` | 0.97 / ats_link | yes | 2; 0 | 6.3 s |
| anthropic | resolved | `https://job-boards.greenhouse.io/anthropic` | 0.97 / ats_link | yes | 4; 0 | 12.7 s |
| netflix | needs_confirmation | `https://netflix.eightfold.ai/careers` | 0.70 / ats_probe | yes | 33; 0 | 10.9 s |
| figma | resolved | `https://job-boards.greenhouse.io/figma` | 0.97 / ats_link | yes | 2; 0 | 4.9 s |
| datadog | needs_confirmation | `https://careers.datadoghq.com/all-jobs/` | 0.50 / landing | yes | 35; 0 | 77.9 s |
| cloudflare | resolved | `https://job-boards.greenhouse.io/cloudflare` | 0.99 / ats_network | no | 7; 1 | 18.5 s |
| canonical | resolved | `https://job-boards.greenhouse.io/canonical` | 0.95 / ats_script | yes | 7; 1 | 12.4 s |
| automattic | resolved | `https://automattic.com/work-with-us/jobs/` | 0.85 / listing_html | yes | 4; 1 | 11.5 s |
| gitlab | resolved | `https://job-boards.greenhouse.io/gitlab` | 0.97 / ats_link | yes | 7; 1 | 13.9 s |
| wise | resolved | `https://wise.jobs/jobs` | 0.85 / listing_html | yes | 3; 0 | 9.4 s |
| salesforce | needs_confirmation | `https://www.salesforce.com/company/careers/jobs/?search=&bc=DB` | 0.50 / landing | no | 25; 2 | 120.1 s |
| siemens | resolved | `https://jobs.siemens.com/en_US/externaljobs/SearchJobs` | 0.85 / listing_html | yes | 7; 0 | 19.5 s |
| spotify | needs_confirmation | `https://jobs.lever.co/spotify` | 0.72 / ats_probe | no | 23; 0 | 46.2 s |
| mozilla | resolved | `https://www.mozilla.org/en-GB/careers/listings/` | 0.85 / listing_html | yes | 3; 0 | 8.3 s |
| basecamp | resolved | `https://37signals.com/jobs` | 0.85 / listing_empty | yes | 2; 0 | 4.1 s |
| monzo | resolved | `https://job-boards.greenhouse.io/monzo` | 0.97 / ats_link | yes | 2; 0 | 4.4 s |
| revolut | not_found | `—` | — / — | no | 31; 1 | 58.9 s |
| zapier | resolved | `https://jobs.ashbyhq.com/zapier` | 0.99 / ats_network | no | 3; 1 | 9.1 s |
| linear | resolved | `https://jobs.ashbyhq.com/Linear` | 0.95 / ats_script | yes | 2; 0 | 4.5 s |
| vercel | resolved | `https://job-boards.greenhouse.io/vercel` | 0.95 / ats_script | yes | 2; 0 | 4.7 s |
| render | resolved | `https://jobs.ashbyhq.com/render` | 0.97 / ats_link | yes | 2; 0 | 4.6 s |

**Release result:** 17/25 labelled sources were correctly auto-resolved at confidence ≥0.85 (68%, below the 80% target). Nineteen chosen sources matched their labels, but that includes two held for confirmation. Nineteen cases auto-resolved in total; two of those were wrong relative to the independently checked manifest. There were four `needs_confirmation` results and two `not_found` results. The verdict is **fail** on discovery accuracy and zero-wrong-auto criteria. Zero extracted cases, zero independent count labels and zero qualifying posting-identity snapshots in this discovery-only run are deliberate unmeasured dimensions, not evidence of extraction failure.

**Wrong automatic accepts requiring review:**

- **Cloudflare:** the manifest labels `https://www.cloudflare.com/careers/jobs/` as the complete company-owned HTML listing. The run auto-selected `https://job-boards.greenhouse.io/cloudflare` at 0.99 by `ats_network`. A render of the labelled first-party page requested the Greenhouse API and linked current Greenhouse role details. That is substantial provenance, but the report does not prove that the public feed has the same scope and filters as the labelled listing. Keep the mismatch until an independent source-equivalence check establishes it.

- **Zapier:** the manifest labels `https://zapier.com/jobs` as the complete company-owned HTML listing. The run auto-selected `https://jobs.ashbyhq.com/zapier` at 0.99 by `ats_network`. The labelled page’s render requested the Ashby board API and contained Ashby role links. The same equivalence and completeness question remains. Do not relabel merely because the scanner found an ATS API.

Other non-matches were not automatically accepted: OpenAI and Revolut were `not_found`; Salesforce returned a scoped `?bc=DB` landing candidate at 0.50 after 120 seconds; Spotify returned a Lever probe candidate at 0.72. Datadog’s exact labelled `all-jobs/` URL was found but remained a 0.50 landing candidate because no postings were verified there. Netflix matched its Eightfold source at 0.70, held for confirmation after the official homepage and browser were denied by robots.txt. Airbnb had a browser navigation warning but still matched its labelled HTML listing.

A separate single guarded [Datadog static-page check](source-audit/datadog-static-listing-mount.json) found an empty client-mounted search/results/pagination region under “Job Openings”. The page has no literal loading phrase or directly empty jobs-named element, so the current rich-loading heuristic does not render it. This explains the 0.50 landing result and suggests a narrow generic render fixture; it does not prove what the rendered listing would contain.

**Matched four-case baseline distinction.** The independent baseline archive at `/tmp/ava-discovery-baseline-vSh7EE/results.json` used the old `d798ccf` discovery bundle with the same 40-fetch/120-second browser/no-AI envelope. Datadog stayed an exact URL match held at 0.50. Siemens improved from a wrong landing at 0.50 to the labelled SearchJobs listing auto-resolved at 0.85. Cloudflare and Zapier moved from mismatched guessed ATS candidates held at 0.70 to mismatched first-party-observed ATS candidates auto-resolved at 0.99. This is a directional comparison of those four cases, not a controlled whole-corpus improvement claim: public pages changed during the day and the new run covered all 25 serially.

**Source snapshot.** Git HEAD was `d798ccfc617612bc864618a4884f639401e49ebf` with uncommitted reviewed changes. SHA-256 of the files at run start:

- `packages/core/src/discovery/discover.ts`: `bb8603ec6bfd084c40e310b4cb1ac0bfe307b5eb801073d1a10f13641b28db5d`
- `packages/core/src/discovery/confidence.ts`: `74c6974845e4725406fbdf92012522bbe5827d8930baa61d3ecdc18782f6926e`
- `packages/core/src/ats/html.ts`: `4a0ca3edaf96ffbe3b0b8d163e336805c608a5537b2579d0f6356ac099578659`
- `apps/worker/src/live-acceptance.ts`: `5a5b428a26dc8db98b4446ebdc7687175b273056cfb053d369d87a2207eddb76`
- `apps/worker/src/live-acceptance-cli.ts`: `d4ce6da42e6d7a48980fbaeafc80b560909e0c2c85bb5dd2b370b415ca084046`

The next decision is an independent review of Cloudflare and Zapier source equivalence and posting scope. Retain the two wrong-auto failures if that review cannot establish equivalence; otherwise revise labels only from dated first-party evidence and rerun the gate. Separately, repair the unresolved/confirmation cases without weakening the 0.85 automatic threshold. This run does not qualify the 50-company daily throughput gate, AI fallback, role extraction, posting recall or provider availability.
