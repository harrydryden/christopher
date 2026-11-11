# ADR 0008: One role credit, bounded AI assistance and direct editing

Status: Accepted and implemented; local verification complete with the broad-run exceptions and affected reruns recorded below. Hosted checks and production release gates remain pending. 11 November 2026.

This decision supersedes per-generation CV credit charging and the disclosure-heavy presentation in ADR 0005/0007 for the journeys below. It retains their account isolation, stable source identities, free durable saving, immutable editions/PDFs, optional checks and explicit source-update rules. It does not change subscription prices, launch advertising, deploy migrations or claim human usability validation.

## 1. Complete delivery scope

Build one coherent journey across opportunity preparation, CV editing, Experience and Applications: identify the current document, edit its visible content, request bounded contextual AI assistance, inspect the result and continue without learning internal baseline/refinement mechanics. Add durable role entitlements and account-wide tier allowances with atomic accounting. All acceptance rows in section 10 are implementation scope; staging is delivery order, not a foundation-only outcome.

No accordions, `details` disclosures, “More options”, or explanatory paragraphs remain in these task surfaces. Essential controls and short field/status labels are visible. Infrequent tasks have a named destination (History, Compare, Role details, Sources, Experience review or Preferences) with a return path preserving buffers. This does not require redesigning unrelated administration screens. The sole contextual-menu exception is the expressly requested writing tool: a visible pixel-star button beside each supported editable text block/title opens exactly three actions. Its dark hover/focus tooltip is **Help me write**, with no keyboard-shortcut hint.

## 2. Opportunity identity and one-time access

A role credit buys the first successfully delivered, usable AI output for an owned opportunity: a full CV, or an explicitly requested scoped suggestion, skills suggestion or Check on an existing valid Manual/Refine document. This includes the operation’s necessary assessment, fitting and internal retries. A Manual save, an empty/failed output or a quality score is not that settlement event. The first operation does not also consume editing allowance. A person starting manually is never forced to generate an Auto CV to unlock assistance; the first request clearly quotes one role credit. A valid proposal/check settles when ready, not on acceptance, so repeatedly dismissing results is not unlimited free computation. Saved warnings remain honest and overridable under existing technical finalisation rules.

An opportunity entitlement is separate from an application context, document edition and role-description version. Several account-owned contexts for the same catalogue job reuse it; their documents, applications and remembered choices remain separate. A source/JD revision, changed priorities, new Experience, reset, additional edition or model-version update does not repurchase the role. Identity is never company/title text alone.

For a catalogue role the identity is account + canonical job ID. Imported/pasted opportunities retain a durable opportunity ID. A proven canonical posting reference can reuse the owned opportunity; otherwise the person explicitly attaches a new context to an existing opportunity or creates a new one. Similar or identical pasted descriptions alone do not prove the same vacancy. Creation retries reuse their request identity. Subsequent edits keep that opportunity identity. Do not fuzzy-merge different vacancies, silently join different accounts, or let arbitrary posted IDs grant access. An explicit separate-opportunity action creates a distinct identity when the person intends a genuinely different role; retries reuse the original request key.

Legacy successful, charged CV work is grandfathered into role access using owned context/job/source lineage. Preserve every historic ledger entry; do not refund or charge historical consumption again. Legacy records without reliable opportunity linkage retain a scoped entitlement to their own saved lineage, rather than guessing that all similarly titled roles are one role. Opening/rebuilding that lineage uses its grandfathered access.

## 3. Editing allowance and published units

After role access is established, new Auto updates and generated Refine work use an account-wide AI allowance instead of another role credit. Account plan determines both a five-hour session allowance and a weekly allowance. Both limits must have capacity before work starts. Role credits/top-ups do not silently buy editing units; existing top-up balances continue to unlock new roles. Manual, exact wording/title edits, structured selections, factual capture, review decisions, layout/order, cached results, preview, finalisation and downloads remain free.

Provisional, versioned product configuration for review:

| Plan | Units per five-hour session | Units per week |
| --- | ---: | ---: |
| Free | 8 | 24 |
| Search | 24 | 100 |
| Intensive | 48 | 250 |

| Explicit AI operation | Units |
| --- | ---: |
| Fix spelling & grammar for one bounded target | 1 |
| Refine wording for one bounded target | 2 |
| Tailor one bounded target to this role | 3 |
| Role-scoped skills suggestion | 3 |
| Optional fresh whole-CV Check | 2 |
| Whole-CV source update or generation with remembered instructions | 8 |
| First successful role AI operation, including required processing | Included in one role credit |

These are deterministic configurable starting allowances, not measured margins or token equivalences. Record actual cost privately to evaluate sustainability; price/tier changes require an explicit product configuration version. The same operation has the same quoted units within that version, regardless of provider retries. Scoped target input is at most 4,000 characters, permitted evidence at most 12,000 characters and role context at most 12,000 characters; selected text is never silently truncated. Set a bounded output ceiling appropriate to the same target, and reject overflow without publication/charge. Select permitted evidence deterministically with explicit omissions rather than treating it as exhaustive. Inputs have published technical size bounds; an oversized text selection is refused before reservation rather than quietly costing more. Operation kind and unit cost are resolved from a server-owned enum; clients cannot submit cheaper units. Every tier can admit the most expensive single operation at a fresh limit. Existing non-CV model products keep their existing explicit billing policy; this allowance is not a back door to unlimited unrelated extraction, search or skill generation.

A five-hour session starts on the first admitted allowance-bearing AI request after the previous session expires. Weekly periods are consecutive seven-day intervals anchored to the immutable account creation timestamp in UTC; show the exact reset in the person’s local time. Time-zone changes, upgrades and first use do not move that anchor. A failed first request can leave the empty window anchor but spends no units. Two compact **AI allowance** bars, five-hour session and weekly, are always visible with their exact reset times; neither is hidden behind a disclosure or replaced by an aggregate bar. A concise refusal identifies whichever limit binds. Reserved/in-progress units are unavailable and shown separately from used units. Never present provider tokens, fabricated editing counts or a generation progress percentage.

Upgrades increase current-window capacity without resetting use; downgrades preserve existing reservations and reduce admission of new work to the new effective plan. Neither payment retries nor refreshes reset windows. Historical operations settle against their original window IDs/configuration even after rollover. Exhaustion disables only new AI work; free editing and exporting remain available with a precise next reset or plan destination.

## 4. Reservation, settlement and recovery

Use transaction-scoped account billing locks and unique request identities. An operation reservation records account, opportunity, operation kind, quoted units/configuration, session/week IDs, source/target fingerprints, request key, lifecycle state and associated task/proposal/draft. Same-intent retries return the same operation; a reused key with different intent fails. Concurrent tabs cannot overspend either window or reserve two first-role credits.

Role access has pending/unlocked states and a claim fence. Competing first builds either join the active operation or wait; they never independently charge. Settle the role credit only when the owned usable draft/proposal/check/skills result is durably published. Subsequent completed AI work consumes allowance when a valid result/proposal is durably available, not when the person accepts it. Dismissing a successful suggestion does not refund the computation. Failed provider/system work releases the reservation without charge. Retry within one operation cannot settle twice.

Cancellation before useful completion releases the reservation; a completion/cancellation race has one transactional winner. If completion already won, the saved result remains accessible and charged, with an honest status. Worker heartbeats/leases and bounded reconciliation recover abandoned reservations; a reservation cannot simply expire while its worker remains authorised to publish. Late publication requires the current claim fence. Never hold a database transaction open across a provider request.

Pending operations remain visible after navigation/sign-in. Refreshing, accepting or dismissing a proposal never starts another provider call. Generation completion never overwrites a current document or dirty buffer in the background. Operational diagnostics remain administrator-only.

## 5. Scoped writing operation contract

The three menu labels are exactly **Fix spelling & grammar**, **Refine wording**, and **Tailor to this role**. Each menu item shows its stable advertised unit cost as secondary metadata before the deliberate request; a locked role instead clearly quotes one role credit for the first successful operation. This is local product configuration, not activation of new production pricing. It acts on the chosen stable text target (summary, heading/title, bullet body/signpost), not a hidden whole-CV rewrite. Grammar preserves meaning; refinement preserves claims; tailoring changes emphasis using the selected role and permitted source evidence. No operation invents employers, dates, numbers, qualifications or other facts.

Request shape: `{requestKey, operation, ownerScope, sourceId, sourceRevision, targetId, targetKind, targetFingerprint, roleContextId?}` plus bounded current target text where editing an unsaved buffer is supported. The server resolves ownership and safe surrounding context/source evidence; it does not trust posted account IDs or arbitrary source blobs. Tailoring requires an explicitly selected role. Context and output bounds are operation-specific. Store a frozen input/engine contract for retries and audit.

The worker returns a proposal, not a new document: `{operationId, proposalId, beforeText, proposedText, sourceFingerprint, targetFingerprint, usage, status}`. Preview is inline beside the target, with visible Use change and Dismiss actions. Both texts remain inspectable without a hidden disclosure. A quoted charge kind, price version and unit cost are bound to the request; changed admission pricing is returned for a fresh decision rather than silently charging a different balance. Use change is deterministic/free and validates the current selected edition, stable target and relevant revision/buffer. A changed target/source produces a recoverable stale result; it never overwrites newer wording or charges again. Dismiss leaves the original unchanged. Other unrelated targets retain their text/order/provenance. Two requests for the same target cannot silently overwrite each other's accepted result.

In Refine, using the proposed wording saves the remembered exact edit and current child edition atomically; existing pending instructions are not executed. In Manual, the action is explicitly labelled **Use change and save Manual CV**: it saves the current Manual buffer, including other visibly unsaved Manual fields, as an owned edition with no learning or factual promotion. A failed save retains both the buffer and proposal; no success notice appears before acknowledgement. Auto is read-only source identity: choosing an edit explicitly enters Refine and creates a child, leaving Auto unchanged. These inline AI tools apply to CV targets only in this phase. Experience remains free direct factual editing; it does not acquire a role-less AI entitlement, model rewrite or factual-promotion path. Structured dates, contact details, identities and factual numeric controls do not receive unconstrained rewriting tools.

### Source-backed skill suggestions

The existing explicit “select new suggested skills” workflow also enriches Experience: selected source-verified labels and their categories are saved once, without a second confirmation. This is a narrow clarification of ADR 0005/0007, not general promotion of model wording. Raw model proposals stay separate. Accepted labels retain `accepted_suggestion` provenance, the suggestion run and exact supporting source citations; they are never relabelled `direct_user` facts. Derived skill tags can be selected/reused, but must not become independent evidence grounding further claims. Generation/verification continues to ground them in eligible original Experience, so repeated suggestion/acceptance cannot create a self-corroborating evidence loop.

The action visibly names the Experience destination and preserves ownership, current suggestion/source identity, ordered labels and idempotency. An accepted category/label does not import arbitrary Manual summary, bullets or other wording. Ordinary CV exact/AI text edits remain governed by their Refine/Manual scope above. Mode-safe acceptance must update the intended CV choices through the corresponding save/fork contract while preserving saved originals and truthful source-drift state. Acceptance itself is free; the explicit generation request consumes the quoted skills allowance or first-role credit.

## 6. Visible editing and current-document model

The CV workspace leads with **Current CV**, role, saved/unsaved status, mode and the one relevant next action. The document text is directly editable in Refine/Manual. Auto/Refine/Manual retain their existing persistence meaning; they are not competing document versions. Mode changes preserve each buffer. Free exact saves are one action; an AI request is one separate, quoted action, with no preparatory “Save instruction” requirement for the contextual tools.

Essential shared controls remain visible: mode, layout settings, selected role/source status, AI allowance, preview and finalisation state. They must not become a wall of repeated help text. History and comparison are named in-workspace task views, not duplicated baseline/edition lists beneath the editor. Visited editors remain mounted while these views are open; pagination loads owned metadata without navigating away or serialising the whole document again. Full-CV rebuilding remains an explicit source-update task with its 8-unit cost, not the default response to a local text edit. Existing saved instructions remain accessible in a dedicated remembered-choices task and are not silently executed by exact saves.

Experience leads with searchable records and direct fields/facts/tags. Privacy/public labels and relevant relationship controls are visible when applicable; history, relationships beyond the ordinary fields and conflict review have clear task destinations. Applications leads with one row per owned opportunity/application context, actual submission state, current CV and next action. Starting/reopening a CV shows whether role access is already included. No stage is inferred from generating a CV, paying a credit or accepting an AI suggestion.

A ready generated edition records the exact refinement IDs and versions already applied to it. Applying only pending order, layout or other deterministic choices projects the selected saved document for free, including a Manual-origin document; it preserves that document’s wording and does not rerun previously applied writing instructions. Genuinely pending writing instructions require the quoted generation operation. An explicit rebuild after removing an applied wording or targeting rule also requires quoted generation when its effect cannot be reconstructed safely alongside surviving writing instructions. The same decision predicate governs the server and the visible price/action, so an “Apply free” control cannot silently become paid work. Appearance and order edits or resets remain deterministic and free. Forgetting a rule for future builds alone leaves the current saved wording unchanged. Legacy generated editions can recover applied-state evidence from their frozen source snapshot; absence of metadata is not permission to treat all current rules as applied. This projection does not promote Manual text into Experience, factual evidence or automatically reusable writing instructions.

Dirty-state protection covers body/title, exact/instruction, structured choices, layout and Experience inputs. Task navigation offers recoverable return; refresh handover preserves the same stable target. No accepted AI result or account refresh can clear unrelated dirty buffers. Technical errors are concise and actionable beside the affected control; essential safety information is not removed merely to shorten the UI.

## 7. Backend and frontend delivery boundaries

Billing owns opportunity entitlement identity/legacy bridge, allowance configuration/readers/reservations/settlement, migration and shared admission integration. Root owns scoped worker/provider contracts, proposal lifecycle/action integration and independently verified publication/failure paths. Readiness owns direct editing, star/tooltip/menu/preview controls, visible allowance/status and removal or relocation of disclosures across the scoped task surfaces. Astra owns this ADR, the journey map and coherence review. Agree shared API types before parallel writes.

Existing legacy CV request/retry/improve/Check actions must use the same admission rules; hiding old buttons is not an authorisation boundary. Resume/fitting/review substeps of an admitted operation do not reserve extra quota. Account access and provider configuration checks run before admission. No provider SDK or server schema barrel enters a client bundle. Bounded reads and intent-loaded separate task screens preserve route budgets without hiding essential controls behind forbidden disclosures.

## 8. Compatibility and staged rollout

1. Add identity/accounting/proposal schema and pure unit-cost contracts; verify fresh and populated upgrades. Preserve existing credit grants and final PDF bytes.
2. Backfill/lazily establish legacy role access under locks with auditable provenance; route all generation entry points through common admission. Existing in-flight legacy work retains its original reservation contract, never both systems.
3. Deliver scoped worker operations with deterministic fixture tests and proposal accept/dismiss flows. Preserve pinned old prompt contracts; new prompts require qualification through the established release gate. No paid live calls are authorised by this implementation task, so any unavailable qualification is an explicit release gate, not fabricated evidence.
4. Replace scoped task UI and integrate visible usage; run complete browser-to-database journeys and bundle/performance checks.
5. Enable only after hosted checks and owner-approved migration/configuration. Rollback pauses new admissions and preserves operations/results/accounting for reconciliation; old code must not double-charge quota-era tasks.

### Deployment and rollback checklist (operator work; not performed here)

- Qualify the new scoped prompts through the strict live evaluation gate, review the provisional allowance costs, and select one verified release commit for both web and worker. Passing deterministic fixtures or the ordinary unverified-report check does not replace this gate.
- Arrange and verify an admissions pause before the release: no new CV builds, Checks, skill suggestions or inline AI requests may enter while versions are being swapped. Use a tested maintenance/routing control; this ADR does not claim an unimplemented product switch exists. Preserve saved documents and free editing where that control permits it.
- Drain existing worker tasks and inspect outstanding credit reservations. Keep the old reservation lineage intact; do not clear holds or mark unfinished work successful to simplify deployment.
- Back up the database and apply migrations **0074_role_entitlements.sql** and **0075_cv_inline_edits.sql** with the normal migration runner. Verify the journal and existing balances, career history, CVs and final PDF bytes. These are additive migrations, not a rewrite of historical purchases.
- Deploy the worker and web from the **same verified release**, containing the shared role/allowance ledger and the `edit_cv_text` handler. Make the compatible worker ready before reopening web admissions. Verify task registration, first-role reservation/settlement, allowance release on failure, and proposal recovery using the agreed operational test account.
- Reopen admissions only after health and accounting checks pass. Watch queued/running tasks alongside reserved `cv_ai_usage` rows; a reservation is not abandoned merely because its wall-clock window has ended.
- If rollback is required, pause new admissions again and drain or reconcile tasks with a **ledger-compatible worker**. Roll back only to a compatible post-ledger release. **Do not restore a pre-ledger worker**: it cannot settle the new usage rows or handle `edit_cv_text`, and can charge old per-draft credits incorrectly. Keep the additive schema, immutable results and ledger history for reconciliation; do not delete usage rows or reverse completed charges as a deployment shortcut.

No production migration, paid provider evaluation, production configuration change or deployment is authorised implicitly by this checklist.

## 9. Coherence decisions and non-goals

A role unlock is durable access, an allowance is bounded new computation, and a saved document is user-owned content. None of those concepts substitutes for the others. Existing source/refinement locks remain explicit; no allowance exhaustion can force factual review or mandatory AI checking. Advertising is not part of the usage calculation or opportunity identity. There is no token resale, automatic subscription purchase, new campaign feature or unlimited-quality promise.

This implementation reduces visible decisions and duplicate controls; it does not prove users understand the product. Validate real task completion with representative people after automated coverage. Do not label the design “intuitive” on browser tests alone. Provisional allowance numbers require operational cost review before paid plan publication.

## 10. Acceptance and proof plan

| ID | Required behaviour and meaningful proof |
| --- | --- |
| U1 | First usable role AI output settles exactly one role credit, including a Manual-first scoped request and internal retries; simultaneous duplicate-context/catalogue-role requests do not double-charge. JD/source revisions reuse access; distinct vacancies remain distinct. |
| U2 | Legacy charged lineage is grandfathered without rewriting/refunding history; fresh/populated migration and rerun preserve saved CVs/PDFs and all balances. |
| U3 | Both quota windows reserve atomically; fake-clock boundary, concurrent tabs, upgrade/downgrade, rollover and abandoned/late worker tests cannot overspend or strand a valid result. |
| U4 | Failures release quota/credit; same request retry and completion/cancel race settle once. Successful dismissed proposals consume their advertised units; acceptance never charges. |
| U5 | Each star operation changes only its selected target, preserving unsupported-fact restrictions, privacy, unrelated wording and source identity. Actual fixture/worker tests distinguish it from whole-CV authoring. |
| U6 | Use-change/dismiss and stale/foreign/changed-target cases preserve buffers; Refine saves a remembered child, Manual stays edition-only, Experience remains free direct editing with no new AI path. Same-target concurrent proposals cannot overwrite silently. |
| U7 | Core task screens contain no accordion/details/More options/explainer paragraphs; essentials are visible, named task destinations return safely, and only the specified three-action writing menu is introduced. Keyboard/touch tooltip/menu/preview works at 390px and 320px. |
| U8 | Current CV/version/mode is unambiguous; free direct editing, title edits, source update, history, comparison, Applications submission and final export all work through production-browser flows with durable DB assertions. |
| U9 | Exhausted allowance still permits all free tasks and valid unchecked finalisation; usage/status reflects reservations/reset times accurately with no fake progress or hidden calls. |
| U10 | Types, focused/full relevant suites, hosted gates, route budgets and prompt qualification status are recorded honestly. No production migration/deployment, paid call or human study is implied by local implementation. |

The coherence review accepted this contract before dependent runtime changes. Completed local evidence and outstanding release gates are recorded below.


## 11. Local verification and remaining release gates

Local implementation and the final production-browser journeys are complete. The suite results below distinguish broad-run checkpoints from their affected reruns; they do not claim that every suite was rerun wholesale against the final commit. Focused counts overlap the broad suites and must not be added together.

| Area | Completed evidence |
| --- | --- |
| Core, AI and database packages | Complete local checkpoints: core 836/836, AI 210/210 and database 155/155. Scoped AI tests use fixtures or mocked provider responses; they do not qualify model quality. |
| Web package | Latest complete run: 2,051 passed and one stale authorisation-inventory expectation failed out of 2,052. The current inventory recognises that deterministic Refine saves require account ownership, while AI work additionally requires verification. The affected authorisation/action/Refine/Role-details rerun passed 296/296 across four files (`/tmp/col-role-web-confirmed.log`), resolving the sole broad-run assertion failure. This is a broad checkpoint plus affected rerun, not a second full-web pass. Earlier legacy workflow fixtures were corrected to their intended Search tier and passed 67/67. |
| Worker package | Latest complete run: 883 passed and one failed out of 884. The sole failure was PostgreSQL deadlock `40P01`: the scan gate sought a shared lock on `cv_drafts` while another transaction sought an exclusive lock on `jobs`; the competing owner is unconfirmed. The isolated SmartRecruiters regression passed 1/1, including two partial 10,000-listing scans with zero closures; the complete affected `apps/worker/src/e2e.test.ts` then passed 113/113 serially on an exclusive test database (`/tmp/col-role-worker-e2e-isolated.log`). No worker implementation or timeout was changed for that incident. This is a broad checkpoint plus a focused rerun, not a claimed all-green full rerun. The CV worker regression set separately passed 34/34, including publication metadata. |
| Role charging and skills | Billing 14/14; mode-safe skill actions 12/12; skill projection/lock regression 1/1; affected Refine/authorisation 267/267; explicit Check 4/4. Cases include duplicate role access, legacy in-flight cutover, refund-safe holds, quote consent, selected-skill ancestry and free structured edits. |
| Interface and navigation | Complete component checkpoint: 315/315 across 71 files (`/tmp/col-role-ui-last.log`). Later task-view/handover tests passed 68/68, save-to-approval tests 28/28, and reset/price-predicate UI tests 23/23. These are separate overlapping checkpoints. |
| Release scripts | 149 passed; two optional database probes skipped because no database was configured for that command: the empty-database shared-account seed and the real-client relay statement counter. The separate database package suite above did run. |
| Migration compatibility | Isolated populated 0073→0075 upgrade preserved career records/assertions/change history, historical CV fields and exact PDF bytes; only new nullable opportunity metadata was excluded from the old-column comparison. Rerunning migrations was a no-op. Fresh-schema integration databases also migrated successfully. |
| Production browser journeys | Final inline fixture passed at 320 px and 390 px: selected text, Use change, stale-result refusal, Dismiss, one-time role charge, subsequent allowance, free saving and no console errors. The complete modes fixture also passed through source rebase/reset, immutable final PDF byte comparison and application recording. Logs: `/tmp/col-role-inline-complete.log` and `/tmp/col-role-modes-complete.log`; result files: `/tmp/cv-inline-browser/result.json` and `/tmp/cv-modes-browser/result.json`. These synthetic journeys made no live provider calls. The broader built-app smoke also passed with all pages rendered, including the legacy CV flow, tailoring, Applications, direct evidence capture, career recommendations and review (`/tmp/col-role-smoke-web-final-8.log`). |

The production build at `2c07fadd` and all route budgets passed. Measured gzip bytes: `/cv/context/[id]` 135,942 / 138,000; `/settings/cv` 115,959 / 117,000; `/library/about` 114,126 / 115,000; shared root 102,481 / 104,000. The About task fell from 139,939 bytes before replacing the oversized editor. The new `/settings/cv` task inherits its 117,000-byte cap from the existing Settings surface; no existing route or shared cap was raised. The complete core rerun also passed 836/836 at this checkpoint.

The normal evaluation-report validator passes **explicitly unverified**. The new scoped prompt registry is `1c2f007d32f7` (`cv.inline_edit` `d3ffd0ce38`; `cv.inline_verify` `5dd810d90b`). Historical live CV reports retain their original versions and are archived; they do not qualify these new operations. The fixture report in `docs/evaluations/cv-inline-edit-2026-11-11/` records zero live provider calls. `COL_EVAL_GATE_REQUIRE_VERIFIED=1` deliberately remains unsatisfied until a separately authorised live qualification is recorded.

The acceptance scope is implemented and locally exercised as follows:

| Acceptance | Delivered boundary and evidence |
| --- | --- |
| U1–U4 | Durable opportunity access and two-window accounting, quote consent, legacy grandfathering/cutover, failure/refund/cancellation fences and migration preservation are covered by database/action/worker tests. First Manual-based AI, subsequent quota and free saves also pass in the production browser. |
| U5–U6 | Scoped generation and verification are separate bounded operations; selection, proposal acceptance/dismissal, stale source protection and Refine/Manual persistence are exercised with mocked providers and the production UI. Successful output never automatically overwrites the document. This is behavioural proof, not live linguistic-quality qualification. |
| U7–U9 | Direct fields, named task destinations, visible filters/layout/allowances, no customer task accordions, quotation/recovery and optional finalisation are implemented. The final browser journeys cover mobile writing controls, source/reset handovers, free editing, immutable PDF bytes and application recording. Detailed build narratives remain server-gated administrator diagnostics; inert legacy components may retain old markup without being rendered on customer task routes. |
| U10 | Local types, package checks, affected reruns, production build, budgets and browser proof are recorded above. Hosted checks are pending at this documentation checkpoint. The strict live qualification gate is intentionally still blocked. |

**Not yet completed:** hosted release checks; separately authorised live qualification of the new prompts; operational cost calibration of the provisional allowances; human comprehension testing; owner-approved production migration/configuration/deployment. No production action or paid provider call was performed for this implementation. The deployment and rollback checklist in section 8 remains mandatory before activation.
