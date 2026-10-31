# ADR 0002: Ranked, editable requirements for each CV

Status: Accepted; implemented and verified locally with live qualification. Hosted CI and deployment remain separate release steps.

Date: 31 October 2026.

Supersedes ADR 0001's fixed three-to-five priority picker and prohibition on explicitly changing the assessed requirements. Its evidence, ownership, page-limit, immediate-save and immutable-export safeguards remain in force.

## Context

The person needs to put role requirements in priority order, correct their wording, decide which are essential, and add or remove requirements for this application. A selected/unselected list does not express that order. Changing the display alone would leave generation and assessment using a different, fixed rubric.

The employer's saved job description and extracted rubric must remain distinguishable from the person's interpretation. Editing a requirement does not establish that the person has demonstrated it, and removing one must not imply that the CV now covers the original job description more fully.

## Decision

Keep the original, job-quoted rubric and its source identity unchanged. Store a separate CV-owned ordered requirements overlay. Each active row has a stable identifier, requirement text, an essential flag and validated role/user provenance. Array position is rank: one is highest. There must be between one and thirty active requirements. Moving a rank moves the row and renumbers the sequence; it does not create duplicate positions or reorder chronological employment history.

The interface uses an ordered table with editable rank, requirement and Essential controls, plus explicit Add and Remove actions. Role-derived wording that the person changes is identified as customised, and additions are identified as user supplied. The original employer wording remains traceable. Concise guidance distinguishes ranking (relative emphasis and allocation) from Essential (coverage priority). Gaps still require evidence; neither control fabricates supporting facts.

Derive an effective rubric from the validated original and overlay. Full rank influences relative writing, fitting and assessment weights; the first five rows supply the compact emphasis/first-page view. The assessment is visibly described as based on customised requirements when the person changes the rubric. It is not represented as an unchanged assessment of every original employer requirement. Model-extracted employer requirements retain the existing exact job-quotation validation; user criteria take a separate explicit validation path and cannot be passed off as employer quotations. Demographic criteria and duplicate/invalid rows remain rejected.

For ranked requirements, the shared weight is `1 + (30 - rank) / 29`: rank one has weight two and rank thirty has weight one, with strictly decreasing weights in between. Essential does not multiply that ranked weight; it separately controls missing-essential reporting and preservation of sole supporting evidence. The earlier top-five emphasis multiplier is not also applied. This keeps the stated highest-to-lowest order meaningful, including when a lower-ranked requirement is essential. Legacy unranked rubrics retain their earlier importance weights.

Save retains wording immediately and stores the choices without starting AI work. Check assesses that saved wording against the effective requirements; Rewrite intentionally generates wording using them. Confirmation, retries, evidence-question continuations and saved revisions retain the same overlay and its order. Changes to requirements invalidate stale evidence mappings, assessments and downstream checkpoints, while preserving the original source rubric and existing credit/queue rules. Original-job or evidence changes remain fenced by source identity rather than silently adopting unrelated choices.

Existing CVs without an overlay remain valid. Their prior emphasis choices supply the initial order, followed by remaining role requirements. Editing a new revision does not rewrite a finalised historical PDF or mutate shared Experience.

The overlay and mapping identity use the existing JSON brief, so no database migration is required. A compatible worker must be available before the web starts emitting ranked criteria; an older worker that only understands the legacy picker must not process these new choices.

## Acceptance and verification

- Rank changes persist across Save, reload, Rewrite, Check and paused-build confirmation; first and last positions are deterministic.
- Editing text, changing Essential, adding and removing rows changes the effective generation/assessment inputs and weights. Original job quotes and provenance remain intact.
- At least one and at most thirty active requirements are accepted; duplicate/foreign IDs, invalid custom IDs, blank/overlong text and demographic criteria are rejected server-side.
- A changed requirement cannot reuse a stale evidence plan or green assessment. A same-request replay with different choices fails instead of reporting a misleading success.
- Existing omission acknowledgements follow the effective essentials and actual mapped evidence; unknown evidence for a new criterion is reported as a gap, never invented or treated as demonstrated.
- Ordinary Save still performs no CV generation/check, Check never authors new wording, and confirmation does not duplicate a task or charge a second credit.
- Desktop and mobile controls are keyboard-accessible, preserve usable touch targets, and do not overflow the page.
- Focused core, action, worker and UI tests cover the contracts. Final production build, bundle limits and browser persistence flow must pass. Changed prompts require truthful qualification of the new ranked/customised path before release; prior live reports remain historical evidence.

## Verification record

The full core suite passes 787 tests and the AI suite passes 207. Focused CV action tests pass 35/35, pending-skill continuation passes 7/7, and the final targeting UI/helper checks pass 8/8. Two worker regressions prove that carried ranked criteria reach planning and assessment, and that a changed criterion causes one remap and at most one omission-acknowledgement pause before resuming. Core, web, worker and AI typechecks pass.

Successive model-free priority edits and legacy appearance-only edits are covered: neither requires a new map just to Save, and changing an old CV's page limit does not silently adopt new priority weights. Visible requirement text resizes without clipping; hidden-tab resizing skips measurement until the table is visible again.

The final production build and all bundle budgets pass; the CV route measures 125,334 bytes gzip against its 138,000-byte limit. The full signed-in browser smoke passes, including mobile rank changes, edited text, Essential changes, adding/removing requirements, exact database persistence and preservation of the original source rubric. The final Review → resize → Write regression confirms long criteria remain visible. Independent desktop/mobile inspection found no page overflow or clipped controls. A local free Save measured 71 ms in an earlier run; this single diagnostic is not a latency guarantee or production speed claim.

The bounded live preparation probe passed against prompt set `8843adc485a0`: two provider calls extracted the original role rubric and mapped nine effective requirements containing the synthetic user edits. Original source and overlay were retained separately, and evidence citations were validated. This probe cost $0.262008, bringing the shared qualification ledger to $1.862171.

The first complete author/review qualification correctly failed factual support: the summary combined tenure from two different titles and used a regulatory company descriptor absent from eligible evidence. The draft was not finalised, and the failed recording is retained. A narrow author/improvement instruction now keeps each title's dates separate and forbids taking company descriptors from omitted profile text or the target employer. This changes the prompt set to `31014dbb8d9a`; extraction, planning, review and factual thresholds remain unchanged.

The corrective live qualification passes all four invariants at `31014dbb8d9a`, with four CV provider calls costing $0.930763. The separate skills probe produces ten suggestions and passes with two calls costing $0.181488. The cumulative qualification ledger, including prior runs, is $4.094703 within the unchanged $10 cap. The exact qualified PDF was visually inspected: one page within its chosen limit, with no clipping. The strict verified release gate and evaluation-script typecheck pass. [Qualification artefacts](../evaluations/cv-ranked-2026-10-31/) retain the original failure evidence; no factual threshold was weakened. This is synthetic qualification, not a guarantee about every future generated CV. No production deployment is performed by this decision's implementation work.
