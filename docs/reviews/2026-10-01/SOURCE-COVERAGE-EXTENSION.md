# Source coverage extension — 1 October 2026

This follow-up extends the [earlier candidate review](CORPUS-COVERAGE-CANDIDATES.md) from 30 to 31 source-labelled companies. New posting counts remain `null`; no complete board enumeration, human posting review or extraction performance is asserted. The earlier report is retained as the evidence and decision record for the first five additions.

## Eighth primary ATS family

On 1 October, I opened [R2's first-party homepage](https://r2.co/) and followed its footer **Careers** link. It resolved directly to the unfiltered [R2 BambooHR careers board](https://r2.bamboohr.com/careers), with no location or search restriction in the URL. The source identity was independently rechecked by the orchestrating reviewer. `bamboohr` is a supported adapter family, so R2 adds an eighth primary ATS family without inventing a board slug from a search result. The board itself rendered as a JavaScript shell in the text reader; this proves the first-party link, not current posting completeness or successful adapter extraction.

The canonical manifest now includes R2 with `expectedRoleCount: null`, `sourceCheckedAt: 2026-10-01`, both source evidence URLs, and a source-only note. Historical results for the 25-case or 30-case corpus do not transfer to this 31-case corpus.

A separate [one-case, discovery-only live diagnostic](implementation-evidence/source-coverage-extension/r2-discovery.json) used the production discovery budget with browser and AI disabled. It resolved R2 to the labelled BambooHR board at confidence **0.97** in **2,815 ms**, using one fetch and one verification. Extraction was deliberately not run. The report's acceptance verdict is **blocked** (the selected case omits 30 required companies and lacks count/posting labels, and the full corpus still lacks bot-protection evidence); this single correct source is not a 31-case accuracy rate or an extraction result.

## Workday multi-region evidence

The two Workday cases now have dated `multiRegionWorkday` tags. The orchestrating reviewer first checked each public host's robots policy, then made one unfiltered, first-page public listing POST per board. The retained [3M observation](implementation-evidence/workday-region/3m-observation.json) records HTTP 200 at 20:21:37 UTC, URL `https://3m.wd1.myworkdayjobs.com/wday/cxs/3m/Search/jobs` and SHA-256 `8b6d411d86f2295dd5fe27430f5ace8eb40c97a4e2b0224bf8154b3c44768c27`. Its [first-page response](implementation-evidence/workday-region/3m-page.json) has actual `jobPostings[].locationsText` in the US, France, Vietnam, India, Mexico and Belgium.

The retained [Workday observation](implementation-evidence/workday-region/workday-observation.json) records HTTP 200 at 20:21:39 UTC, URL `https://workday.wd5.myworkdayjobs.com/wday/cxs/workday/Workday/jobs` and SHA-256 `8d8f8e3ad2963bf5dc861edaa34b1c64729b0c701bdfad50882229c92004b326`. Its [first-page response](implementation-evidence/workday-region/workday-page.json) has actual `jobPostings[].locationsText` in Costa Rica, Ireland, the US and Canada. The [3M](implementation-evidence/workday-region/3m-robots.txt) and [Workday](implementation-evidence/workday-region/workday-robots.txt) robots responses are retained beside those observations.

The countries are observed in postings from the exact unfiltered board API backing each labelled Workday source. They support corpus **composition** only. The responses' `total` fields are machine-reported and are not human-reviewed denominators; one page cannot establish complete recall, precision or the elapsed time to scan an enterprise board.

These same Workday responses exposed a separate extraction gap. Some postings have a literal `N Locations` `locationsText` field; a separate public [detail response](implementation-evidence/workday-region/workday-multi-location-detail.json) for one such posting names its primary city and 69 additional locations. Treating the count string as the full location can falsely exclude a location-sensitive follower. The [Workday location-gap design](WORKDAY-LOCATION-GAP.md) specifies durable enrichment and failure handling; no location-correctness fix is claimed here.

## Adjacent adapter repairs

The core Teamtailor URL recogniser now accepts the vendor's real `career.teamtailor.com` jobs host as a Teamtailor board while continuing to exclude `app` and `www` product hosts. This corrects the unsupported-host observation in the [earlier candidate review](CORPUS-COVERAGE-CANDIDATES.md); Chip remains the independently linked third-party Teamtailor corpus case. This recogniser repair does not by itself establish extraction completeness for the vendor board.

The Workday mapper now uses an explicit `remoteType: "Remote"` signal when supplied by the board, and still recognises an explicitly remote `locationsText` fallback. It does not infer remote status from `Flex` or `Hybrid` metadata. Targeted tests cover these distinctions; they are mapping checks rather than a measured role-level accuracy rate.

## Bot-protection investigation

No `botProtected` case was added. A bounded check of [VALD's official careers page](https://vald.com/careers) reached `careers.vald.com`; the text reader reported HTTP 403, but an ordinary direct GET of that same URL returned HTTP 200 with a Breezy portal HTML body and no challenge marker. That disagreement does not establish bot protection. Oterra's expired TLS certificate and Netflix's robots restriction likewise are not bot-protection evidence. No CAPTCHA or challenge was attempted or bypassed.

An actual case needs a first-party-linked careers/listing source plus a retained dated response with an explicit challenge indicator, such as a challenge header or verification page. A bare HTTP 403, a robots disallow or a TLS failure should remain untagged.

## Current structural preflight

After the manifest extension, the retained [offline corpus preflight](implementation-evidence/source-coverage-extension/corpus-preflight.json) reports 31 selected and distinct companies, eight primary ATS families (Ashby, BambooHR, Eightfold, Greenhouse, Lever, Teamtailor, Workable, Workday), five evidenced custom HTML cases, two JavaScript-heavy cases, two multi-region Workday cases, one landing-to-external-board hop, zero bot-protected cases and no invalid evidence. It intentionally [exits `2`](implementation-evidence/source-coverage-extension/corpus-preflight-exit.txt) with only the bot-protected stratum missing. Final focused checks passed: [core ATS tests 130/130](implementation-evidence/source-coverage-extension/core-tests.log) across three files, [worker acceptance tests 61/61](implementation-evidence/source-coverage-extension/worker-acceptance-tests.log) across four files, [core typecheck](implementation-evidence/source-coverage-extension/core-typecheck.log), [worker typecheck](implementation-evidence/source-coverage-extension/worker-typecheck.log), [worker build](implementation-evidence/source-coverage-extension/worker-build.log) and `git diff --check`. The full SPEC §9 quality bar remains unqualified until this last structural case and the separate human-labelled and operational gates are completed.
