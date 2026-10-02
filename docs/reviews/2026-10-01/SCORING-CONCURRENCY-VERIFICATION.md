# Score freshness and bounded location evidence — 1 October 2026

This checkpoint follows local commit `5d02f02`. Astra directed the investigation and assurance boundaries; Sol agents implemented the repairs and independently reviewed the writer protocol. It closes the local concurrency and location-input concerns identified in [the previous checkpoint](LOCATION-CONSISTENCY-VERIFICATION.md). It does not certify any job at 90 or qualify a production release.

## Development completed

A score can take time to return while the user edits preferences, evidence or decisions. Publication now holds shared transaction fences while checking the current inputs and writing the answer. Audited account-input writers hold the matching exclusive fence; global model settings use a separate global fence. Company, job and role-view row locks protect their inputs. The ordered protocol is global fence, account fence, gate, company, job, then role view. Review exposed and repaired conflicting orders in unfollow and source retirement. A discovery result also checks the locked current company name before replacing a placeholder, preserving a manual rename made during the fetch.

Migration **0053** adds a per-view attempt counter. Older answers cannot overwrite newer attempts even when both were prepared in the same millisecond. Legacy batches without a counter settle their accounting but cannot publish; necessary fresh work is queued. Profile changes and the newly covered decision, tag, company-name and model-route changes commit their re-scoring requests atomically. New automatic fanout respects confirmed-member/admin eligibility. Final review also found an existing Library-save bypass of that policy; Library edits still save, but automatic role re-scoring now requires a confirmed member or administrator. Existing synthesis/tagging authorisation paths are not claimed to have received a comprehensive security audit.

Preparation reads fresh settings and pins the resolved A5 model and effort into both live and batch requests. The fingerprint includes that route and the A5 prompt version. The full re-scoring cache key now includes the decision digest, route, prompt version and company names, preventing queued changes from being discarded as unchanged. Ordinary unchanged role inputs still reuse their previous result.

Canonical stored locations and the score fingerprint retain the full list. The model-facing location portion is bounded to **12 KiB of UTF-8 after escaping**. It scans every name for configured location-term matches, prioritises matching evidence, and samples other names across the list. If the list does not fit, the request explicitly states total, included and omitted counts, including omitted matching places. The prompt forbids treating omitted places as evidence of a mismatch. This bounds one input section; it is not a universal token cap or proof of model judgement quality.

## Verification

All model responses used for this checkpoint are local test doubles. Database integration checks used isolated databases on the local PostgreSQL service at port 55439. No production migration, deployment, paid provider call or external notification was performed.

| Evidence | Result and scope |
| --- | --- |
| [Independent publication concurrency](implementation-evidence/scoring-concurrency/worker-publication-concurrency.txt) | 6/6 real PostgreSQL tests using two pools and actual blocker observation: writer-before-publisher, publisher-before-writer, company deletion, same-clock attempts, unfollow and another role's decision. The last two exercise the SQL protocol, not authenticated browser actions. |
| [Worker input regression](implementation-evidence/scoring-concurrency/worker-input-regression.txt) | 74/74 focused scoring, batch, location and enrichment checks. |
| [Discovery rename](implementation-evidence/scoring-concurrency/discovery-name-regression.txt) | 1 targeted test passed; 108 unrelated tests deliberately skipped. |
| [Web writers](implementation-evidence/scoring-concurrency/web-writer-regression.txt) | 77/77 affected settings, decisions, applications, admin, Library, learning and verification checks across seven files. |
| [Account confirmation](implementation-evidence/scoring-concurrency/web-verification-regression.txt) | 4/4 after adding focused regressions: unconfirmed decisions and Library saves do not add a full re-score; confirmed saves do. Library versions still save before confirmation. Seed-profile save eligibility is also checked. |
| [AI request construction](implementation-evidence/scoring-concurrency/ai-location-regression.txt) | 136/136 across request, batch, location-evidence and prompt-registry tests; live/batch pin the same route and bounded evidence. |
| [Canonical locations](implementation-evidence/scoring-concurrency/worker-location-regression.txt) | 3/3 pure location checks, including retention of the final place. |
| [Migration checks](implementation-evidence/scoring-concurrency/db-migration-regression.txt) | 17/17. |
| [Typechecks](implementation-evidence/scoring-concurrency/typecheck.txt), [final web typecheck](implementation-evidence/scoring-concurrency/web-typecheck.txt) and [AI typecheck](implementation-evidence/scoring-concurrency/ai-location-typecheck.txt) | DB, worker, web and AI passed. |
| [Worker build](implementation-evidence/scoring-concurrency/worker-build.txt) and [web production build](implementation-evidence/scoring-concurrency/web-build.txt) | Both passed. |

The [writer audit](implementation-evidence/scoring-concurrency/publication-lock-audit.md) maps each scoring input to its writer and follow-up. These guarantees cover audited application writers; direct SQL and old running code do not take the fences. [Deployment instructions](../../DEPLOY.md) require a coordinated migration and upgrade of all writers. Mixed-version production behaviour and hosted throughput remain unqualified.

The [request-size diagnostic](../../benchmarks/a5-location-budget-2026-10-01.json) uses maximal configured companion text and mocked requests. The ordinary 70-place list fits completely in 1,813 bytes. The 1,000-place ASCII and CJK cases use 12,089 and 11,659 bytes of location evidence, retain the final relevant place and disclose incompleteness. Whole request sizes are 50,313 and 49,883 bytes. Reservation estimates use the engine's byte/3 proxy and repository pricing, not measured provider tokens or charges. Live semantic quality and actual cost still need qualification.

A5 is now version **`e831973c07`**; the prompt set is **`27311fe3cb21`**. Previous recordings cannot establish acceptance of this changed prompt set. No new UI components changed in this checkpoint; prior phone/keyboard captures remain historical evidence, not fresh human usability results.

## Re-score and remaining development

Readiness remains **J1 83, J2 77, J3 85, J4 83, J5 85, J6 85, J7 80, J8 83, J9 70**. Dimension scores remain unchanged in the [canonical scorecard and ordered roadmap](../2026-09-29/RESCORE-90.md). This checkpoint strengthens local score freshness and recovery evidence, but does not establish the broader outcomes needed to increase those ratings.

Next qualification remains: complete and independently label the source corpus (including a genuine bot-protected case); measure full posting recall/precision; run current verified provider replay and independent output review; test representative first-time and returning-user journeys with accessibility coverage; obtain genuine learning decisions; and qualify the authorised hosted release, recovery and capacity. Repairs must follow any failed gates. Every job reaching 90, with completeness at least 4.5, robustness at least 4 and UI/UX at least 4, remains outstanding.
