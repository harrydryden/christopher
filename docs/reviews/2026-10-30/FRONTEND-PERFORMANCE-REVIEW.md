# Frontend performance and task clarity — 30 October 2026

## Decision and scope

Follow the existing six jobs in `docs/UX-JOURNEYS.md`, checking current source and browser behaviour rather than reapplying the historical recommendations. Prioritise the path from choosing a role to writing, checking and using its CV. Keep ordinary Save free and independent of AI, manual edits intact, account scoping, active filters, evidence confirmation and paid-action costs explicit.

Speed has three separate meanings here: how soon the useful interface appears, how quickly an action responds, and whether a necessary background wait remains understandable. Do not claim faster AI generation from a frontend rendering change. Use truthful stage and connection state; no invented completion percentages or time estimates.

## Review by job

| Job | Current foundation | Decision in this pass |
| --- | --- | --- |
| Start receiving useful roles | Intent-based onboarding, preferences and first-scan checklist already exist. | Preserve setup and explicit empty-state distinctions. Do not infer a product defect from the performance fixture's intentionally unchosen preferences. |
| Monitor companies confidently | Shared monitoring strip, source exceptions and hidden-tab polling already exist. | Preserve existing shared monitoring. Show role-related background progress in the role journey without adding a second polling loop. |
| Decide which roles to pursue | Compact filters, visible active selections, optimistic decisions, undo and on-demand role descriptions exist. | Make waiting for the role list recognisable; give failed details an in-place retry tied to the current role. Keep prior actions and filters reachable. |
| Produce an accurate CV | Write, Review and Appearance tabs, explicit Save/Check/Rewrite, measured preview and revision guards exist. | Reuse unchanged previews; simplify repeated action explanation; show current processing and stage first, with technical history on demand; distinguish lost updates from a stopped build. |
| Maintain reusable evidence | Unified work-history cards, question-to-evidence flow and lazy schema/recovery imports exist. | Preserve exact confirmation and edit recovery. Monitor the tight bundle budget; no speculative editor rewrite or heavy shared dependency. |
| Manage applications | Due work and contextual updates already exist. | Preserve the application/CV hand-off and immutable finalised PDFs; no additional panel or workflow is justified by this review. |

This is an expert review and synthetic verification, not a moderated usability study or a measured improvement in hiring outcomes.

## Technical findings and implementation contract

1. **Repeated preview rendering.** The baseline browser sends a second `/api/cv/preview` POST for identical wording. Reuse the existing current preview; changed content or appearance must invalidate it. Guard duplicate clicks, stale responses and object-URL cleanup. Do not mount the hidden inline PDF viewer, or start a request after leaving while its validation code loads. An absent or invalid measured page-count header must never become a misleading zero-page result.
2. **Expensive hidden detail during a build.** The full active narrative is constructed on each clock tick alongside the compact stage summary. Mount and compute the detailed narrative only when requested. Keep the current stage, elapsed time, real recorded progress and recovery action visible. Avoid announcing elapsed seconds repeatedly to assistive technology. Keep mobile stages in a compact two-column layout, rather than four tall cards.
3. **Connection state masquerading as live progress.** CV polling backs off after failure while continuing to show the last reading without a connection warning. Preserve the last known work, report unavailable updates, and clear that warning after recovery. A connection failure is not evidence that the worker stopped.
4. **Role-detail failure requires excessive recovery.** Retry the description in place, rejecting stale responses and invalidating cached failures as role identity/lifecycle changes. Do not let a late response populate a different or removed role.
5. **Role-list waiting lacks task context.** Stream an appropriately sized list fallback while the route's shell appears. Preserve filter transition feedback and distinguish active scoring from completed, unavailable or blocked work. Use the existing work feed rather than parallel polling.
6. **Repeated explanatory text competes with editing.** Put the effect in the primary action label and keep detailed explanation in existing secondary disclosures. Keep Generate skills, selected-skill saving, free Save, paid Rewrite and factual warnings discoverable.

Prefer removing work to adding memoisation. Existing optimistic updates, dynamic imports, lazy logos, per-request query reuse and hidden-tab polling are retained. Do not enable eager prefetching for every role or add a shared mutable cache for account-owned content.

The implementation follows [Next.js 15 navigation and streaming guidance](https://nextjs.org/docs/15/app/getting-started/linking-and-navigating) for early shell/loading feedback, and [React's memoisation guidance](https://react.dev/reference/react/memo) to optimise measured repeated work rather than wrapping every component.

## Baseline and verification method

Baseline commit: `39556636df2b066953c4f5361cbd703353ee2410`, with all five hosted CI jobs and Vercel preview successful. The previous CV refactor is recorded separately in `docs/evaluations/cv-targeted-2026-10-30/refactor-review.md`.

Use the existing production build and a separate local `ava_perf_frontend_1030` database seeded by the repository's performance fixture: 100 synthetic accounts, 20 shared companies and 1,000 roles. No customer records or provider calls are used. The legacy fixture CV provides a repeatable editing baseline; targeted/active-build states require separate behavioural fixtures.

Baseline browser checks at 1440px and 390px: no page errors or horizontal overflow on Roles, CV and Experience. Preview POSTs: one for the first request, two cumulatively after an unchanged repeat, three after changing the summary. The page-ready diagnostic includes `networkidle` and is not a user-perceived latency benchmark.

Warm local page measurements use four samples after two warm-ups, through the repository's PostgreSQL statement-counting relay. Timings are diagnostics only. Compare statements, payloads and actual requests under the same fixture; do not turn local millisecond differences into a hosted speed claim.

| Baseline route | Statements | HTML gzip bytes | RSC bytes |
| --- | ---: | ---: | ---: |
| Roles, Matched | 13 | 19,203 | 55,835 |
| CV | 14 | 12,489 | 22,900 |
| Experience | 14 | 13,576 | 29,368 |

## Implemented results and verification

The six findings above are implemented. The CV preview action now becomes **Open current preview** when the wording and appearance still match. The inline viewer and detailed build log are mounted only when opened. Role details offer a local **Retry details** action. A streamed loading state identifies the role list; a notice shows actual pending scoring. A lost CV progress connection preserves the last known stage and reports reconnection separately from worker failure.

The first visible CV editor has 249 words versus 305 in the same synthetic baseline (56 fewer, about 18%). The full explanation remains available in disclosures beside its action. This is reduced reading burden, not a claim that the full document has fewer DOM nodes: the initial CV DOM is 288 versus 284 because the accessible disclosure controls also need markup.

| Behaviour | Before | After |
| --- | --- | --- |
| First preview / unchanged reopen / edited preview | 1 / 2 / 3 cumulative PDF POSTs | 1 / 1 / 2 cumulative PDF POSTs |
| Hidden inline PDF viewer | Mounted after rendering | Mounted only while opened |
| Closed build log on each clock tick | Full narrative computed | No detailed narrative computation |
| Failed role description | Whole-page reload suggested | Retry in place; two requests including the injected failure, zero document reloads |
| Progress connection failure | Old reading silently remained | Last-known-stage warning, cleared by the next successful reading |
| Score completion without a role-row write | Notice could remain while company work continued | Version changes and the existing poll removes the notice |

Browser checks use the production build at 1440px desktop and 390px mobile. Roles, CV and Experience have no page exceptions or horizontal overflow. The synthetic fault checks confirm role retry, score-notice completion while company work remains active, and CV progress failure/recovery with no false stopped state. Detailed progress opens and closes correctly. A deliberately slowed local database (100 ms per client packet) confirms the Roles loading region arrives in an earlier response chunk than the table; this is a streaming-order assertion, not a hosted latency benchmark.

Regression coverage includes duplicate preview clicks during lazy validation, leaving before validation resolves, invalid/missing page counts, edited-preview invalidation, hidden narrative computation, lost/recovered progress reads, role request identity/removal and task-only scoring transitions. All 86 focused tests pass (38 CV, 29 Roles, 19 work-status). The production build, typechecks and every route's existing bundle budget pass. The final hosted test and Lighthouse results are attached to the PR for its exact head.

### Payload and query trade-off

There is no material reduction in initial page payload or query count from this pass. The wins are avoided repeat work, smaller visible explanations and truthful feedback while waiting. Same-fixture warm measurements:

| Route | Statements before / after | HTML gzip before / after | RSC raw before / after |
| --- | ---: | ---: | ---: |
| Roles, Matched | 13 / 13 | 19,203 / 18,974 | 55,835 / 56,096 |
| CV | 14 / 14 | 12,489 / 12,509 | 22,900 / 22,900 |
| Experience | 14 / 14 | 13,576 / 13,575 | 29,368 / 29,368 |

Small streamed-HTML/gzip differences include chunk ordering and build artefacts; they are not attributed to an algorithmic improvement. No provider prompt, generation algorithm, migration, account budget or paid AI call changed.

### Continuing performance contract

- Gate first-load JavaScript and authenticated desktop LCP, CLS and TBT in the existing CI; keep the mobile measurements visible. Experience is close to its 142,000-byte gzip budget (141,458 bytes), so new editor features must preserve lazy loading and avoid adding shared dependencies.
- Treat optimistic decisions, draft Save, role descriptions, preview reuse and build recovery as separate journeys. A fast page load does not prove these actions respond well; preserve the request-count and lifecycle regressions added here.
- Keep actionable warnings, costs, factual confirmation and unsaved-work protection visible. Hide optional explanation and history, not information needed to make a decision.
- Use existing authenticated performance telemetry for real-device field distributions. This review establishes local reproducible behaviour; it does not establish production p75 latency or prove that the interface is intuitive to first-time users. A short moderated task study remains the way to validate that assumption.

Machine-readable local evidence is in `frontend-verification.json`; before/after measurements use the same account, roles and library. Recovery tasks were completed and their synthetic CVs archived before the final page measurements. Screenshots and test fixtures contain only synthetic accounts.
