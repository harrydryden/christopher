# ADR 0005 — Stable Auto CVs, role refinements and independent Manual editions

Status: Accepted and implemented. The core mode implementation and the section 11 workflow-completion follow-up are implemented; the section 12 guided-editing follow-up is verified locally as recorded below. The guided-editing follow-up awaits hosted review checks and has not been merged or deployed. Human comprehension testing remains unperformed.

## Context and superseded decisions

The user has approved three ways to work on a CV: use a dependable automatic result, refine it for this application, or edit a standalone version. These are editing modes, not build stages or a compulsory sequence. The same workspace must make the current version, unsaved changes and next useful action clear.

The current system already saves wording without AI and checks without rewriting it. It also has conflicting policies: a default-selected Remember wording option stores local edits in account-wide preferences; role choices belong to individual revisions; automatic improvement can replace the apparent current version; and retention can delete all but one predecessor. A ready CV may be unchecked, yet finalisation requires a current assessment. Company/title matching can also conflate different applications.

This decision supersedes those policies for the new workflow. In particular it supersedes ADR 0003's mandatory current-assessment prerequisite: a person may finalise a saved, renderable CV without AI review after expressly acknowledging its unchecked state and visible findings. It does not weaken ownership, concurrency, exact-content approval or immutable PDF rules. Existing snapshots and historical PDFs are not rewritten or relabelled as proven Auto/Refine results.

## 1. One application context, independent state dimensions

Introduce an account-owned, durable application context UUID. A stored posting resolves to a context owned by that account; an explicit pasted role receives its own context rather than using company/title as identity. Reopening that pasted role uses the saved context. A new application with the same title may deliberately create another context. Job deletion leaves the role and description snapshots usable. No cross-account context or CV lookup is permitted.

The context owns immutable description versions and reusable refinement versions. A changed description creates a new version. Unchanged requirement IDs may survive only when their exact source identity remains valid; changed or removed criteria produce explicit rebase conflicts. No fuzzy matching silently assigns an old instruction or evidence link to a new requirement.

Keep these dimensions separate:

| Dimension | Meaning |
| --- | --- |
| Editing mode | Auto, Refine or Manual; how this edition is produced and reused |
| Execution | Queued, working, waiting for a decision, ready or failed |
| Local changes | Saved or unsaved; a refresh must not replace unsaved text |
| Assessment | Unchecked, current, stale, or current with findings |
| Approval | Draft or final; a final decision records whether it was checked |

Legacy revisions retain a legacy provenance marker until explicitly forked into a mode. The interface may offer Manual as the safe editing action without claiming that the historical text was manually authored.

## 2. Auto is an immutable stored result, not a random rerun

An Auto baseline is account- and context-owned and immutable once published. A canonical input identity covers exact job/description version, confirmed source/profile content and IDs, the base role priorities, explicit base style preferences, base appearance/page/font settings, resolved provider/model routes and effort, prompt/review contracts, and versioned writing/fit/render contracts. Canonical serialisation ignores object-key order, not meaningful array order. Refine selection/treatment/order/wording/instruction overlays and Manual text are excluded. The refined-result identity adds the ordered overlay versions/dependencies to the selected baseline identity. Reset all removes that overlay and returns to the selected Auto baseline with its base priorities, source snapshot and appearance intact; it does not reset the role, description or Experience.

An unchanged request returns the same stored baseline content and identity without a provider call, task or credit. Merely reopening Auto does not allocate another revision. A user who starts editing forks an edition; the immutable baseline remains available for comparison and reset. Concurrent equal requests share one pending build and at most one credit reservation. A failed or incomplete artefact is not a successful cache hit; retries retain existing lease/refund rules rather than bypassing billing.

Auto produces a usable default from the original role rubric, deterministic recommended ordering and already confirmed Experience, without a mandatory priority confirmation or evidence quiz. Here, **base priorities** means the deterministic extracted source rubric; user ordering, Essential and criterion-text edits are Refine overlays. Gaps remain visible; adding facts is an explicit Experience action and offers a new Auto input afterwards. Priority, treatment and wording refinements are optional. This prevents a paused confirmation from changing the evidence/choices beneath an existing canonical claim. Legacy paused builds retain their existing continuation contract. An explicit change to the source role description, evidence or base appearance creates a new keyed baseline; it does not mutate the selected one.

Store the baseline artefact outside ordinary draft pruning, or protect its exact referenced revision with an explicit retention invariant. It must include sufficient validated content, source and review provenance to reopen it after other draft revisions are removed. A baseline must never depend on a parent that retention can delete.

Pin the engine contract selected for the baseline. An unrelated deployment does not regenerate a CV. When source inputs or a supported engine version change, show an update opportunity; generating the updated baseline is deliberate and preserves the old one. No automatic optional-improvement adoption may change the baseline or active edition. If the existing optional improvement is retained, it is a separate candidate offered for explicit adoption; it is never silently selected.

An unfinalised Auto baseline stores its content and render-contract identity, not historical renderer binaries. If that contract is no longer available, its content remains recoverable but its preview must ask for an explicit update or new edition rather than silently rendering a different layout. Finalised PDFs always retain and serve their original approved bytes. This is an explicit compatibility limitation, not permission to change a cached result on opening it.

## 3. Refine is reusable for this application

Refinements belong to the account's application context, not the global Experience library. Each has a stable UUID, immutable version, deterministic order, a target, a kind, text and source dependencies. The interface distinguishes:

- **Exact wording:** keep the supplied text exactly at a stable summary/section/item target. This is a user-authored edit, not evidence and not an instruction that the model may paraphrase.
- **Instruction:** a reusable direction such as emphasising a supported contribution. It applies only when the person explicitly asks to generate a refined edition. Saving the instruction itself is free and does not call AI.

Selection, requirement ordering, inclusion treatments, skill ordering and appearance are structured refinements, preserving their existing validation rules. Changed criteria invalidate affected maps/checks. Exact wording changes invalidate the relevant claim review; layout changes recompute PDF measurements while reusing semantic checks only under the existing complete identity contract. A wording lock that no longer has a valid target or whose evidence changed is surfaced as a conflict; no silent transfer by array index and no fabricated corroboration.

Each refinement is visibly modified and offers Reset. Reset one removes only that instruction/wording override; Reset all restores the selected baseline for this role. Neither deletes confirmed Experience. Compare shows baseline versus refined text/choices. An explicit source update offers rebase with retained compatible IDs and unresolved conflicts. Role refinements never leak to another user or another context with an identical company/title.

A saved Manual edition may supply a comparison reference and explicitly selected wording to promote into Refine without first paying for Auto. Merely entering Refine does not promote the entire Manual document, turn it into evidence or make its unselected wording reusable. Generation still uses confirmed Experience or the selected Auto baseline plus explicitly saved refinements. When there is no Auto baseline the interface labels the comparison source honestly.

Applying exact wording is deterministic and free. Applying instructions may enqueue a generation task with a visible price; unchanged baseline plus unchanged refinement versions reopens the stored refined edition without another call. The worker applies exact wording after authoring and before measurement/review, never treats it as new factual evidence, and reports unsupported locks rather than silently rewriting them. Fitting may reduce unlocked generated prose, but cannot paraphrase, prune or reorder an exact locked target to make it fit. An incompatible lock or unresolvable page overrun remains a visible conflict/warning with the original text recoverable. Check never authors.

## 4. Manual is independent, recoverable and never learned

Manual forks the currently selected saved content into an independent edition. It is also available directly from a role without a paid Auto build: deterministically start from the owned profile/Experience or a minimal editable document, with no model call or baseline prerequisite. Free Save preserves its wording, priorities, formatting and order. It does not write global preferred wording, role refinements, search learning, confirmed skills, evidence rows or any Auto cache. This prohibition is enforced server-side even if a stale or forged form submits old Remember wording fields. Generated skill proposals are suggestions; adding new facts to Experience remains a separate explicit, confirmed action with its own destination and version checks.

Mode switches preserve unsaved buffers and clearly identify which one is active. Rebuild/update creates a new edition and leaves the Manual snapshot available; it never replaces or silently incorporates Manual text. Moving text into a reusable refinement is a separate explicit action, showing its role scope and target. Promoting a factual statement to Experience likewise requires an explicit confirmation/import review; there is no implicit extraction path from Manual content.

Saved Manual editions, baselines and finalised/submitted editions are exempt from automatic one-predecessor pruning. They remain recoverable until explicitly deleted by their owner, subject to existing live share/application protections. Restoring an old edition forks a new working edition; it never mutates a finalised version or its PDF. History is paginated, not silently truncated. Existing historical rows survive the additive migration; already-deleted history cannot be reconstructed and must not be implied recoverable.

## 5. Optional checks and explicit finalisation

Save is immediate and free in Refine/Manual. Check is optional and clearly priced where applicable; it assesses exact saved wording and measures layout, without rewriting. Auto generation may retain its existing built-in assessment, but that does not make Check a compulsory stage for other modes.

Finalisation has one clear action for the saved revision. Before approval, perform cheap deterministic content/render checks and show the actual page count, preferred limit, current assessment state and any known findings. Without a current assessment, say **Not checked** (or **Checks are out of date**) and require an explicit acknowledgement of that state. With unresolved findings, acknowledge those findings. A content/revision/source-bound token prevents an earlier acknowledgement approving later edits. No AI request, task or credit is needed to finalise an unchecked document.

The server locks and revalidates ownership, idle lifecycle, exact content/revision, acknowledgement and successful PDF generation. Invalid/unrenderable/empty PDF, foreign ownership, an in-flight or paused build and stale approval remain technical refusals. A renderable page overrun is an acknowledged warning, not a veto. Store the actual PDF bytes plus approval mode, measured page count and exact content identity; retain prior assessment and findings as history without presenting them as current. Download, sharing and Applications serve those immutable bytes and display checked/unchecked approval truthfully.

## 6. Coherent workspace and jobs to be done

Keep one CV workspace and stable layout with **Auto / Refine / Manual as the primary choices**. Layout is a shared secondary panel and Feedback a contextual panel; Write/Review/Appearance no longer compete as primary tabs. Map existing fragment links to the corresponding editor/Feedback/Layout panel so deep links remain useful. Show a concise saved/build/approval state and one primary next action; advanced explanation is disclosed, not repeated above every control. Progress names current work, distinguishes waiting for the person from active processing and reconnecting, and never invents completion percentages. A background result appears as an available edition; it cannot replace an actively edited snapshot or reset the chosen mode.

Implement the wider approved navigation simplification in this change, retaining existing routes and deep links:

| Job | Primary destination and concrete change |
| --- | --- |
| Find suitable roles | **Find roles** contains role results and secondary employer discovery/following views. Companies moves beneath this job rather than competing as a primary destination. Keep user filters, archive, explicit follow/scan status and retry controls. |
| Pursue an opportunity | **Applications** owns preparation and tracking. Shortlist/prepare links carry the exact account-owned application context. Building a CV means preparing, never submitted/applied. Submission remains an explicit action tied to the chosen final PDF. |
| Maintain reusable facts | **Experience** owns confirmed evidence and one import-review surface for CV, LinkedIn export and pasted text. Source choices feed the existing confirmation/deduplication flow; no automatic URL fetch or factual promotion. |
| Tune discovery | Learning/search profile becomes secondary **Preferences**, retaining gate controls and transparent learning history. CV Manual edits never affect it. |

No route deletion, catalogue ownership change, gate bypass or loss of existing filters is required. Primary navigation and contextual labels implement the new hierarchy; existing company/discovery/settings URLs remain available within it. Import processing, review, confirmation and failure use one consistent state presentation, not competing entry cards with different promises.

## 7. Coherence audit and implementation boundaries

| Current conflict | Resolution and invariant |
| --- | --- |
| Company/title role key conflates applications | Durable account/context UUID; explicit pasted-role identity and JD versions |
| Remember wording globally learns default edits | Explicit Refine scope; Manual server-side no-learning |
| Auto always allocates/charges | Locked canonical lookup/claim before reservation; same result and one build |
| Optional polish silently becomes current | Separate candidate; explicit adoption, immutable active baseline |
| One archived predecessor can delete Manual history | Protected baseline/Manual/final artefacts; explicit deletion only |
| Revision-local choices disappear on new build | Context-owned immutable refinement versions with exact target dependencies |
| Current assessment required to finalise | Explicit unchecked approval with exact render/content acknowledgement |
| New job or evidence silently reuses stale refinements | Exact dependency checks and explicit conflict/rebase, no fuzzy transfer |
| Background refresh can change active content | Pinned edit base and per-mode buffers; new result offered separately |
| Companies, learning and preparation compete in navigation | Find roles / Applications / Experience; secondary contexts preserved |

Backend owns pure mode/context/refinement contracts, additive migrations, transactional baseline claims and publication, worker application/invalidation, retention and finalisation. Frontend owns mode/edit/compare/reset controls, consistent action/read models, navigation/import presentation and accessible feedback. Shared contracts must be agreed before concurrent edits. Broad splitting of files or changes to discovery algorithms are not part of this decision.

## 8. Persisted contracts and transitions

All records below are account-scoped. Public actions derive the user from authenticated server state; they never accept a trusted `userId` from the browser.

| Record | Required fields and invariants |
| --- | --- |
| `cv_application_contexts` | UUID, owner, optional posting ID, company/title snapshot, current description-version ID and explicitly selected edition. Resolve a stored posting within its owner; explicit new-application creates a distinct context. Pasted creation has an idempotent request key; reopening supplies the existing owned UUID. Completion does not silently select a background result over a current edit. Retained history does not become multiple current Applications rows. |
| `cv_context_descriptions` | Immutable UUID, context, increasing version, exact description/source and canonical hash. Description updates append; unchanged text reuses current version. |
| `cv_auto_baselines` | UUID, owner/context, canonical input key and validated input snapshot, pending/ready/failed state, claimed draft/task identity, pinned engine contract. Published content, source, targets and assessment/provenance are immutable. Unique owner/context/input key fences concurrent requests. A complete artefact does not depend on retention of its producing draft. |
| `cv_refinement_events` | Context, stable UUID, version, kind `instruction`/`exact_wording`/`structured`, target, bounded payload, order, exact source/description dependencies, reset tombstone. Optimistic set version rejects overwriting a concurrent edit. Latest non-reset events form the active ordered snapshot. |
| Draft lineage | Nullable context ID, editing mode, baseline ID, immutable refinement snapshot and stable editing-target metadata. Null mode preserves legacy provenance. Summary/section/bullet/skill targets have stable IDs independent of their current array positions; duplicated text has distinct target IDs. Reorder retains IDs; new items receive new IDs; deleted targets are not silently reused. |
| Approval artefact | Exact edition/revision/content/source identity, actual page count, acknowledgement and `checked`/`unchecked` state, visible warning snapshot and stored PDF bytes. Historical unknown review provenance remains unknown. |

Core exports `CvEditingMode`, `CvAutoInputV1`, `cvAutoInputKey`, `CvRefinementV1`, `CvRefinementSetSnapshot`, `cvRefinedResultKey`, `CvRefinementConflict` and `cvApplyExactLocks`. Browser-safe types/pure display helpers are separate from schemas, PDF and provider dependencies.

The action surface reuses existing lifecycle transactions rather than implementing an independent credit/publication system:

| Action | State and work contract |
| --- | --- |
| `openOrClaimAutoCv(contextId, intent)` | `open` returns the selected pinned result/status without a claim, task or charge. Explicit `update` validates current inputs under the account/context lock and looks up/claims their canonical key before allocating credit or task. Ready hit returns the same baseline; pending hit returns the same build. A separate explicit retry uses existing refund/lease admission. Publish through a matching claim identity so stale completion cannot overwrite a newer claim. |
| `saveCvRefinements(contextId, expectedSetVersion, edits)` | Append validated events atomically. Free; no provider call. Validate target ownership, source dependencies and stable IDs. |
| `resetCvRefinement(contextId, id or all, expectedSetVersion)` | Append reset events; no evidence deletion or baseline mutation. Free. |
| `createCvEdition(contextId, mode, sourceEditionId?)` | Fork owned saved content into a mode-specific edition, pin base/targets, preserve the source. With no source, Manual starts deterministically without Auto/AI. Manual never imports active refinement instructions implicitly. |
| Existing `saveCvDraft` | Mode-aware free Save; Manual ignores/rejects legacy learning and suggestion-persistence fields. Validate pinned base identity and item IDs before applying text/order. Refine writes only explicitly submitted refinements, not every incidental UI change as instruction. |
| `generateRefinedCv(editionId, expectedSetHash)` | Explicit paid instruction application using baseline plus immutable active refinements. Reuse identical completed refined result; no author call from Save or Check. Preserve current editor/source edition. |
| `prepareCvFinalisation(editionId, expectedRevision, baseHash)` | Render exact saved content, return measured warnings/check status and server-verifiable identity token. No model call. |
| `approveCvFinalisation(editionId, token, acknowledged)` | Require literal boolean acknowledgement, recheck locked identity, technical lifecycle and render; persist checked/unchecked approval and exact PDF atomically. Token binds the render contract as well as source/content and warning identity; an old token cannot authorise changed content or a changed renderer. The server re-renders within that pinned visual contract rather than claiming to promote previously stored preview bytes. |

An Auto request pins its engine versions before enqueue; resuming uses those versions or reports that the required version is unavailable rather than silently changing the baseline. Failed publication cannot leave a ready cache entry. Optional candidates never change the cache key's published result. Library confirmation is a separate explicit transaction; Manual forms cannot invoke that path indirectly.

| Change | Reuse and invalidation |
| --- | --- |
| Pure mode switch, reopen, reset display | No generation; reopen the selected stored artefact/buffer |
| Manual wording/skill/order Save | New local edition; invalidate affected review, no global learning or Auto invalidation |
| Refine exact text or structured edit | New overlay version and derived edition; retain compatible unrelated semantic stages; never mutate Auto |
| Refine instruction Generate | New/reused refined-result identity; explicit author work; exact locks preserved |
| Layout/font/page change | New output identity and actual render; only exact semantic identity may reuse assessment components |
| Confirmed evidence/profile or JD change | New base input; invalidate dependent mapping/claims; retain old versions and flag incompatible refinement targets |
| Explicit engine upgrade | New pinned input contract and deliberately requested baseline, no silent replacement |
| Background completion | Publish only its claimed result; expose candidate/edition without replacing an active editing buffer |

Rollout is additive: migrate nullable lineage and new tables first; deploy workers able to read both legacy and mode-aware payloads; then enable web producers. Old workers must not receive new mode tasks. Legacy requests retain their existing interpretation until explicitly adopted/forked; migration never invents reusable instructions from historical wording. Finalisation readers recognise both historical approval and explicit unchecked records. Release verification includes upgrade from an existing populated schema as well as a fresh database.

## 9. Acceptance and verification

| ID | Required behavioural proof |
| --- | --- |
| M1 | Same Auto canonical inputs return identical baseline ID/content with zero new task/credit/provider work; concurrent duplicate requests reserve/build once. Failure retry remains bounded. |
| M2 | Evidence, JD, priorities, explicit preferences, font/page or pinned model/prompt/fit/render version changes invalidate the correct result; JSONB key reordering does not. Updating engine version is explicit. |
| M3 | Stored and pasted roles have durable isolated contexts; same-title applications and two users cannot share refinements or artefacts. Changed JD exposes incompatible targets. |
| M4 | Refine exact wording survives generation unchanged, instructions are applied only explicitly, reset one/all and compare use stable IDs, and neither reset touches Experience. Obsolete locks produce conflicts. |
| M5 | Manual Save makes no model call and writes no global preferences/refinements/evidence/learning, including forged legacy fields. Rebuild and async completion preserve saved and unsaved Manual work. |
| M6 | Repeated edits, mode switches, concurrent completion and stale same-ID refresh cannot replace active content; inaccessible or stale targets fail without partial writes. |
| M7 | Unchecked/stale-reviewed and warning-bearing saved CVs finalise after exact acknowledgement with zero AI work; missing/old acknowledgement, foreign/paused/running revision, empty or invalid PDF fail. Stored bytes and checked state remain immutable. |
| M8 | Baselines/Manual/final/submitted versions survive normal retention and remain recoverable; reset does not delete them. Legacy migration preserves content, IDs, PDF bytes and honest unknown provenance. |
| M9 | Check preserves wording; semantic reuse remains keyed to exact facts/claims/rubric/model/prompt/review contract; layout-only updates measure pages again. No automatic optional candidate replaces a chosen edition. |
| M10 | Find roles → shortlist/prepare → Applications uses exact context; Companies and search learning remain reachable beneath their jobs; existing deep links, filters, status transitions and account isolation work. |
| M11 | All document/text import entry points reach one source-aware confirmation flow; unconfirmed rows cannot become evidence, Manual content is not automatically imported, and import errors do not discard edits. |
| M12 | Desktop and 390px keyboard/browser journeys cover Auto hit, Refine/reset/compare, Manual/save/rebuild, unchecked final PDF and application attachment, with no overflow or lost edits. |

Validation will include pure canonicalisation/projection tests; real-database ownership, uniqueness, credit, retention and lifecycle races; worker no-author/selection/invalidation tests; component accessibility and state tests; production browser flows and bundle budgets. Record avoided calls/queries and representative local Save/cache-hit/render timings, not unmeasured speed percentages. Keep external/live suites separate; any changed provider prompts require exact-version synthetic qualification using the existing bounded harness before release readiness.

Deploy additive schema before producers, support legacy null-mode rows, then enable new creation paths with matching worker support. No production migration or deployment is implied by implementing this ADR. Final verification and any remaining limitations must be recorded here against M1–M12; none of the approved jobs above is silently deferred.

## 10. Completed local verification

The following evidence is local and synthetic. It is not a production rollout or a claim that final hosted checks have passed.

| Acceptance | Evidence collected |
| --- | --- |
| M1–M3 | Action integration covers concurrent equal Auto requests, one task/reservation, ready cache hits and pinned reopening; account/context ownership and description boundaries are enforced by the action and database layers. |
| M4 | Pure projection and action tests cover stable targets, exact locks, free successive refinements, original-baseline reset lineage and preserved saved editions. Action/worker regressions carry the original source rubric and effective ordered criteria through free and paid Refine; changed criteria invalidate prior assessment and evidence mapping. The live ranked Refine scenario also passes. |
| M5–M6 | Action tests cover Manual no-learning, including the forged legacy Save route. Component rerender tests fence Refine buffers against changed sources; the production-browser journey has exercised Manual Save and mode-buffer preservation without queued model work or Library writes. |
| M7 | Finalisation integration covers unchecked approval, immutable stored PDF/provenance and refusals for foreign, stale, paused, active or forged requests. The browser verifies finalisation without model work, download equality with stored approved bytes and retention of that PDF after reset. Final display distinguishes intentional unchecked approval from stale historical checks. |
| M8 | Fresh migration and populated pre-0064 upgrade pass through 0070, with all 69 journal entries and idempotent reruns. The legacy final draft ID/content and exact PDF bytes remain unchanged; nullable new provenance stays unknown. History tests cover 31 baselines and 31 editions with tied timestamps, no pagination gaps, and an older selected edition. |
| M9 | Worker regressions prove Auto Check does not author or mutate its immutable baseline, and layout-only Manual Save retains reusable rubric/plan/audit while remeasuring layout with zero author/review calls. Free appearance-only Refine retains compatible cache/plan; criterion changes invalidate assessment/plan. Saved Manual wording with no confirmed Experience receives unsupported findings without authoring or fabricated evidence; generation still refuses empty evidence. The final complete shuffled worker run passes. |
| M10–M11 | Applications tests cover multiple contexts for one posting plus pasted/no-build contexts. Navigation/import tests preserve existing routes, source selection and confirmation. The production browser verifies final application attachment to the correct context; mode-aware detail pages retain tracking without exposing incompatible legacy edit actions. |
| M12 | The final production build and strengthened browser journey pass: Auto cache hit, free exact and chained skill-order refinements, Manual copy/save, mode-buffer preservation, unchecked final PDF byte equality, reset-all with retained final history, keyboard use and no page overflow at 390px, and application attachment. No browser JavaScript errors were recorded. |

Complete suites pass: core **806/806** across 56 files, AI **208/208** across 12 files, database **120/120** across 15 files, the normal worker run **883/883** across 70 files, the final shuffled worker run **884/884** across 70 files and web **1,774/1,774** across 197 files. The additional worker case covers saved Manual wording without confirmed Experience. The final action suite passes **4/4**, including two separately cited successive bullet locks, a re-edited cited summary and immediate refusal of an unanchored generated target. All five package typechecks and evaluation typecheck pass, as does the final production build.

The database-backed release suite passes **147/148**, with one explicit skip: the shared-account benchmark seed requires an empty database, while the retained task database contains companies/CVs. Existing records were not cleared to satisfy this unrelated benchmark precondition. The database relay probe ran. Local-server tests required loopback access. The isolated replay suite passes **14/14**, including Auto and Refine record/replay identity and source rollback; the added ranked structured Refine scenario also passes its focused replay. The first complete web run found 14 failures: stale UI/inventory expectations and a real old-schema read fallback defect. Those were corrected and the complete rerun passed, including focused ownership/old-schema tests.

The changed author/improvement instruction contract passed bounded live qualification at prompt set **`f21a62396b80`** (author/improvement **`db10cb442f`**). The synthetic Refine scenario combines an instruction with ranked structured choices, records genuine provider responses and replays without misses; claim and page invariants pass. Four CV calls cost **$0.728887**, and two skill calls cost **$0.135528**, producing ten suggestions across five categories. The existing cumulative guard ledger reports **$5.709337 of $10** spent, including earlier tasks; the ledger was not reset. Reports and the synthetic qualified PDF are retained in [the qualification record](../evaluations/cv-modes-2026-11-02/README.md). This proves the exercised synthetic path, not general writing quality or production latency. Unfinalised Auto rendering across incompatible renderer versions remains the explicit limitation described in section 2; finalised PDFs are unaffected.

One local synthetic browser sample measured workspace load at **557 ms**, Auto reuse at **894 ms**, Manual Save at **55 ms** and finalisation at **64 ms**. These are local diagnostics, not service targets or a before/after speed claim. The new `/cv/context/[id]` production route measured approximately **13.5 kB** for its own route and **134 kB** first-load JavaScript. The behavioural performance claims are the verified absence of new model tasks/credits on cache hits, exact projections, Manual Save and finalisation, plus reuse of compatible assessment work.

Refinement binding deliberately fails closed when a newly generated item has no retained stable Auto anchor: saving it exposes the conflict immediately rather than accepting an instruction that would later attach to another item. Manual remains available for independent wording. No fuzzy or positional rebase is claimed. Together with the renderer compatibility rule and synthetic evaluation scope above, these are explicit limits of the implemented contract. Production migration/deployment and hosted CI are separate release steps.

### Hosted browser-gate follow-up

The first hosted run at `2e519117` passed the main checks (including types, release checks and evaluation gate), worker image, shuffled worker tests, Lighthouse and Vercel preview. Its browser job exposed stale import-chooser and legacy finalisation assertions. The updated smoke retains substantive checks: unsaved edits prevent PDF approval; measured warnings require explicit acknowledgement; findings and dismissal history remain intact; the downloaded PDF equals the approved stored bytes. The complete legacy browser journey now passes locally.

CI also runs the Auto/Refine/Manual browser journey through its explicit CLI, using a separate, guarded local database and server. That exact invocation passes locally, including cache reuse, chained free refinements and skill order, preserved Manual buffers, unchecked approval, reset/history, keyboard/mobile use and application attachment.

The new workspace now has an explicit **138,000-byte gzip** route budget, matching the existing CV editor rather than raising shared/default limits. A narrow lazy boundary for Refine and Manual reduces the manifest-union first-load measurement from **140,437 to 129,842 bytes** (12 to 11 chunks; two large chunks unchanged). Visited editors remain mounted and loading states are accessible. Browser observations show 11 JavaScript resources before mode visits, 13 after Refine and 14 after Manual; cached transfer sizes are not used to claim a total network-byte saving.

Follow-up verification passes: production build, all route bundle budgets, seven mode-component tests, six bundle tests, web typecheck, both complete browser journeys and **148/148 release-script tests**. This last isolated run exercises the benchmark case skipped by the earlier retained-database run. Only the two databases created for this follow-up were removed, and the retained PostgreSQL container was restored to its original stopped state. No prompts, migrations or provider calls changed. Those historical pending checks were resolved before PR 133 merged into main at `a1047410`. No production deployment is claimed here.

The subsequent hosted browser run passed both journeys and measured the new workspace at **129,997 bytes**, below its 138,000-byte cap. `/roles/add` measured **115,038 bytes** versus **114,783 locally**, exceeding the generic limit by 38 bytes. An explicit **116,000-byte** allowance gives that route 962 bytes of measured hosted headroom for build variation; shared, global and other route limits remain unchanged. This is a configuration-only adjustment, with no runtime refactor. PR 133 subsequently merged into main at `a1047410`; the workspace-completion follow-up below starts from that merged version.

## 11. Accepted workflow-completion follow-up

The first implementation established the mode, ownership and persistence contracts, but the UI still exposed several incomplete transitions: display-only role text, conflicts without a guided rebase, incomplete comparisons, disabled duplicate Layout controls, legacy Check fragments and duplicated selected-version/approval areas. This follow-up completes those transitions rather than changing the meaning of Auto, Refine or Manual. The cross-product [journey and state map](../ux/journey-state-map.md) defines discovery, Following, roles, import, CV and application states, their recovery paths and task-based acceptance. It is a product/state audit, not a claim of completed human usability research.

### Sources and explicit rebinding

Editing the role description uses the existing account-owned, expected-version action. Saving a changed description is free and appends a description version; it never alters a saved CV, starts generation or loses a mode buffer. Known Experience/role drift is visible before the person chooses Update Auto. Updating Auto remains an explicit request with the existing cache/credit contract. Once a current ready baseline is available, a guided review offers compatible remembered choices and identifies conflicts.

A dirty Manual edition can still be saved against its owned, pinned older role version after a description update. The new Manual snapshot retains that exact description, source references and check semantics, with its older-role basis visible. Saving does not silently adopt the newer advert, promote evidence or request AI. Choosing a newer source is a separate explicit action; source updates must not strand recoverable Manual wording.

The rebase action contract is:

- `previewCvRefinementRebase(contextId, expectedVersion, fromBaselineId, toBaselineId)` returns the overlay version, destination description identity, a preview key and a result for each active refinement.
- `applyCvRefinementRebase(contextId, expectedVersion, fromBaselineId, toBaselineId, expectedPreviewKey, acceptedIds)` recomputes the preview under the context lock and rejects a changed role, overlay or source snapshot. It appends immutable versions only for explicitly accepted compatible rules; it creates no task, credit reservation or CV edition.
- Both baselines must be ready and belong to the same account/context; the destination must use the context's current description. Anchors match only by unique exact evidence citations/text and owning entry, or exact skill identity. Summary/section dependencies must likewise match. No array-position, fuzzy text or ambiguous whole-entry matching is allowed.
- Appearance may rebind independently of evidence. Item order requires every referenced target to map exactly. Role-dependent structured criteria/instructions require compatible original rubric identity; an edited role criterion is never silently relabelled as an employer requirement.
- New rules may record their baseline origin in existing refinement JSON. An older untagged rule is eligible only when its stored target, description and dependency hash exactly recompute against the explicitly selected source baseline. Unproven Manual-derived or missing/changed/ambiguous anchors remain conflicts. A Manual snapshot is never implicitly promoted or reused as evidence.
- Unaccepted/conflicting events remain visible and prevent applying an unresolved set until explicitly edited, rebound or reset. Partial rebase never silently drops a remembered rule, deletes Experience or rewrites historical editions.
- A repeated preview after partial application recognises already-current rules. It does not mislabel the rules just rebound as Manual-origin conflicts or ask the person to reset them.

### One coherent workspace

One selected-saved-edition summary identifies the exact mode/version, processing and check/approval state. Auto materialisation feeds this state; it does not add another Check or approval panel. Mode-specific Save/Apply remains the primary action for local changes, with free/paid intent explicit. Feedback has one Check and final-approval destination. Approval refuses when the relevant visible edition has unsaved wording; a different hidden mode buffer is preserved and is not misidentified as the edition being approved. Pending remembered Refine choices are distinguished from the saved result they have not yet changed.

Layout has one usable shared surface. Manual changes its local theme buffer and persists with Manual Save; Refine changes its remembered appearance choice and applies it through the existing free projection. Auto remains immutable and offers the explicit transition into Refine. Mode buffers stay mounted after visiting; no disabled duplicate form or link to an incompatible legacy editor remains.

Legacy content, Feedback and Appearance fragments map to the corresponding context mode/panel and keyboard focus, including repeated same-fragment navigation. A successful Check reveals its actual progress without requiring a legacy Write tab. Progress completion may refresh saved data but cannot hard-reload over dirty mode buffers.

Refine presents summary, sections and items in document context, with remembered state and Reset beside the affected target. Exact wording and instruction intent remain distinct; an advanced instruction surface may remain secondary. Comparison uses stable target/section identities rather than a single entry-ID map, and explicitly includes additions, removals, wording/signposts, section/item order, priorities/Essential flags, treatments and layout. An unavailable historical source is labelled unavailable rather than described as unchanged.

### Follow-up acceptance

| ID | Required proof |
| --- | --- |
| W1 | Description updates preserve selected saved content and dirty buffers; unchanged updates do not create work. Source drift is visible before an explicit Auto update. |
| W2 | Exact compatible rebase preserves stable intent across source versions; changed/ambiguous/foreign anchors conflict. Stale preview, overlay or source identity fails atomically; only accepted IDs get new event versions. Older untagged rules require exact recomputation proof. |
| W3 | Comparison exposes removed/added/reordered sections and skills, changed priorities/Essential/treatments and layout, including repeated entry IDs and missing historical data. |
| W4 | One shared Layout control edits the correct Manual/Refine buffer; switching modes preserves both buffers and persistence remains free where defined. |
| W5 | A single selected-edition Check/approval flow names the saved version, blocks its dirty wording and preserves unrelated hidden buffers. Progress and legacy fragments select/focus the correct destination without losing edits. |
| W6 | Remembered indicators and individual/reset-all actions work beside actual content; applying/resetting one rule preserves other rules, saved editions and Experience. |
| W7 | The journey-state map covers empty/loading/partial/failure/recovery states across the primary jobs; existing discovery, role/import and application controls remain reachable and preparation never implies submission. |
| W8 | Desktop/390px keyboard browser journeys exercise the above decisions, with bundle budgets and no-generation-on-save assertions retained. Human comprehension validation uses the map's protocol and is reported separately, not fabricated. |

W1–W8 are implemented and locally verified by the evidence below. These cases supplement M1–M12. Human comprehension testing remains a separate validation activity using the journey map’s protocol; it is not represented by automated browser tests. No deployment, new provider stage, paid call or schema migration was performed for this follow-up.


### Follow-up verification record

| Acceptance | Implementation and proof |
| --- | --- |
| W1 | Version-fenced role editing preserves dirty Manual wording and its pinned older description. Canonical source-drift notices work for either a selected Auto baseline or saved edition. Action, refresh and drift regressions pass; the browser has exercised update → preserved buffer → free older-source Save. |
| W2 | Preview/apply binds owned from/to baselines, current role, overlay version and exact source identity; only selected compatible events are appended. Partial rebase recognises already-current rules; missing, empty, changed or ambiguous evidence conflicts. Pure and real-database action regressions pass. |
| W3 | Comparison resolves the exact retained Auto baseline or Manual parent, then shows additions, removals, ordering, wording/signposts, role priorities, Essential flags, treatments and real theme fields. Unknown historical inputs are labelled unavailable. Resolver and component regressions pass. |
| W4 | One shared Layout panel registers independent mode buffers and saves through the active mode. Auto offers an explicit Refine transition; pending saves disable only the relevant controls. Repeated mode-switch and buffer tests pass. |
| W5 | Selected edition identity, preview, Feedback and approval share one surface; history is collapsed. Relevant dirty Manual wording blocks approval. Legacy fragments handle lazy mounting and malformed input without trapping later mode switches; progress avoids destructive reload over dirty buffers. Focused state tests pass. |
| W6 | Compact contextual rows show remembered state and Edit/Reset beside the target, with one inline editor. Mirrored skill bullets are hidden normally but remain editable as historical targets. Existing order updates retain the rule ID; reset preserves other choices, editions and Experience. Focused component/action tests pass. |
| W7 | The linked journey-state map covers the cross-product lifecycle and recovery states. The complete legacy browser journey confirms existing navigation, import confirmation, CV decisions, applications and sharing remain reachable. Human comprehension testing remains a separate, explicitly unperformed validation activity. |
| W8 | Production build and typechecks pass. All route budgets pass: workspace **132,743/138,000 gzip bytes**, shared **102,074/104,000**. The final strengthened mode-workspace browser journey passes on the final production build, including 390px keyboard use, no overflow and no JavaScript errors. |

The source/dependency and comparison changes are covered by the complete core suite (**810/810**, 57 files), CV editing action integration (**6/6**) and server-action authorisation (**239/239**). The action cases exercise explicit partial rebinding, stale preview rejection and a free Manual save pinned to its earlier role description. Missing or empty evidence anchors now fail closed; two absent values cannot count as proof of unchanged evidence. Comparison tests use the retained Auto baseline or exact Manual parent, not the selected result as its own source, and label unavailable history explicitly.

Focused UI checks pass **34/34** across seven component files, covering clean versus dirty role-description refresh, the exact server-rendered field label, independent shared Layout buffers, dirty Manual approval refusal, cold and malformed fragment navigation, contextual skill deduplication, updating an existing order rule and complete comparison fields. Three additional resolver tests prove actual historical source selection and fail-closed source/target/version mismatch. The final Refine checks pass **6/6**, including editable historical skill targets, stable order-rule updates and compact non-duplicated headings. Source-drift checks pass **4/4** with schema-valid raw and grouped role/structured-employment fixtures: fresh Auto does not falsely report changed Experience, runtime appearance/writing overlays are excluded, factual row/profile changes remain detectable, and an older Manual edition retains source-drift feedback. Normalisation preserves factual line text/order and metadata while removing grouping-only blank-line differences. Web typecheck passes after this final helper correction. The complete web suite passes **1,802/1,802** across 200 files. Database-backed release checks pass **148/148**, with no skips; the earlier no-database run had two explicit skips. The complete legacy production-browser journey passes, covering navigation, imports, CV approval, evidence questions, application records and sharing. The final production build, all typechecks and final mode-workspace browser journey pass. Source-wizard SSR label regressions pass **4/4**, and web typecheck passes after the final label correction. No worker generation, provider prompt, migration or paid-call contract has changed. The existing exact-version evaluation gate passes without new model calls.


The final independent mode-workspace browser journey verifies role-description update while Manual wording is dirty, preservation and free Save against the older role snapshot, approval refusal before that save, immutable final PDF bytes, no false Experience drift after a fresh Auto result, source preview with compatible and conflicting remembered choices, explicit free partial rebase, repeated preview recognising already-current choices, reset/history preservation and application-context attachment. The same final build passes keyboard use at 390px without horizontal overflow or browser JavaScript errors. These are synthetic task-based acceptance checks, not a human comprehension study.

One local diagnostic sample measured workspace load **533 ms**, Auto reuse **848 ms**, Manual Save **50 ms** and finalisation **65 ms**. JavaScript resources rose from **11** initially to **13** after Refine and **14** after Manual. These observations describe this local run only; no production latency, percentage speed-up or total transferred-byte improvement is claimed. Final manifest-union bundle measurements are **132,743/138,000 gzip bytes** for the workspace and **102,074/104,000** shared. The latest drift regression is **4/4**, with no fresh provider calls. Hosted checks, merging and deployment remain separate steps.

## 12. Accepted guided-editing follow-up

The section 11 checks established correct transitions but still required separate Save and Apply steps for exact wording, exposed source-selection mechanics before useful decisions, and repeated remembered wording beside the current document. This follow-up reduces those actions without changing evidence, cost or approval rules. It does not claim human comprehension testing has taken place.

### One free exact-edit transaction

**Save and update CV · free** stores the selected exact-wording refinement and creates/selects its saved result in one account-scoped transaction. It starts from the explicitly identified, current ready edition and preserves all other wording, including previously generated instruction results. A source may be an immutable Auto baseline or an owned ready Refine/Manual edition. Using a Manual source does not promote the rest of that snapshot into evidence, reusable locks or global preferences.

The action is `saveAndUpdateCvExactRefinement(contextId, expectedOverlayVersion, source, input)`, where `source` is `{kind: "baseline" | "draft", id, revision?}` (revision required for a draft) and `input` carries the optional existing refinement ID, stable target, exact text, ordering and a retry-stable `requestKey`. Success returns the new overlay version, draft ID/revision and `charged: false`. The context’s authoritative selected pointer must match this source. An immutable Auto source is usable directly without an extra materialisation action. The request binds application context, expected refinement-set version, source kind/ID and exact source/target identity. Existing target IDs and dependency authority remain mandatory; no positional or fuzzy attachment is introduced. The retry identity includes the complete source revision, expected overlay and edit intent. A repeated request succeeds with its original result only while that result remains current with a compatible overlay; otherwise it reports a stale/conflict outcome. It never rewinds selection, creates duplicate rules/editions or charges. The action uses the established context-first lifecycle locks. Either the refinement event, saved edition and selected-edition pointer commit together, or none do. The existing public save and generation actions must not be chained into a partially committed operation.

This action never authors, reserves a credit or queues model work. Saved instructions already reflected in the selected edition remain reflected in its wording; unapplied instructions remain visibly pending and require their separate, priced generation action. An unsafe target, changed source, active task or incompatible rule produces an actionable error with the typed buffer intact, not a successful save followed by a hidden paid operation. Content changes invalidate the applicable review identity; unchanged provenance and unrelated wording are preserved. Finalised sources are immutable and any permitted edit produces a new draft.

### Current CV and primary action

The workspace identifies one **Current CV** using the authoritative selected edition, with its mode/version, saved or unsaved state and a direct preview. Switching editing modes changes the method, not which saved CV is current. History is a secondary disclosure with meaningful version/date/state labels and explicit selection; it does not duplicate the current document's actions.

Opening an exact edit prefills its current displayed wording. After a successful exact save, the editor briefly locks editing until the matching saved-child identity is adopted; it then resumes at the same stable target. That handover preserves independent unsaved instruction and structured-choice buffers. A different deliberate history selection clears the handover state with an explicit recovery path rather than leaving an indefinite lock. Remembered state and removal belong beside that target; the document is not repeated in a second generic list. A single-rule removal is labelled **Forget for future builds** and explicitly leaves the current saved wording unchanged. It must not pretend to reset the displayed CV. The separate Reset all action still explicitly restores the clean Auto result while retaining saved editions. The visible primary action is determined by the task: save an active exact/Manual buffer, explicitly generate saved instructions, show work in progress, or approve/download the current saved CV. Optional Check and Layout stay available as secondary actions. Conflicts and dirty buffers cannot be concealed by changing the primary button's wording. Closing or switching an edit offers save/cancel/recoverable retention rather than requiring the person to copy text before reload.

### Guided source update

The normal source-update path derives the current remembered source and eligible current-role destination from owned saved lineage. Manual from/to selectors move to an advanced recovery path; they are not compulsory for a normal update. The UI explains what changed, keeps the old current CV usable while a new Auto result is prepared, and retains the existing explicit generation price/cache-hit behaviour.

Once a destination is ready, the existing exact rebase proof determines compatibility. Compatible/already-current choices are summarised, not presented as a page of repetitive confirmation rows. Only actual changed, missing, ambiguous or unsupported anchors require individual decisions. One explicit carry-forward confirmation authorises the compatible set; it remains bound to the preview key and overlay/source versions. Conflicts are neither silently dropped nor falsely marked compatible. Applying a safe exact result remains free; paid instructions remain a separate decision. The UI must say whether remembered choices alone changed or a new current CV was saved, and provide the next useful action without returning the person to source-selector mechanics.

### Acceptance and boundaries

| ID | Required proof |
| --- | --- |
| G1 | One exact Save updates both the remembered rule and current saved CV atomically, with zero tasks/credits/provider calls; duplicate, stale, foreign, active and invalid-target requests cannot partially commit. |
| G2 | Exact edits preserve generated instruction wording and unrelated claims; pending instructions stay pending. Manual-origin exact edits remain free and do not learn unselected Manual content. |
| G3 | An exact editor opens with current wording; save failure and mode/source refresh preserve recoverable dirty text. A successful save updates the current-version identity and preview without another Apply click. |
| G4 | A normal source update does not require choosing from/to IDs or reviewing compatible rows individually. Exact compatible transfer and real conflict decisions remain version-fenced; old saved/final PDFs remain recoverable and unchanged. |
| G5 | One current-CV surface and contextual controls replace duplicate action/rule lists. History, optional Check, Layout, priced instruction generation and explicit approval remain accessible by keyboard at 390px. |
| G6 | Component/action tests and the independent production-browser journey prove the above, with unchanged bundle ceilings and truthful local work-avoidance measurements. Human comprehension research remains explicitly outstanding. |

No prompt, schema migration, provider stage or deployment is planned. The implementation will reuse the current source-matching, refinement-dependency, immutable PDF and mode-buffer contracts; a demonstrated need to change those boundaries must be recorded rather than silently weakening them. G1–G6 are implemented and locally verified by the evidence below. Hosted checks, merging and deployment remain separate release steps; human comprehension testing remains outstanding.

### Guided-follow-up verification record

Implementation is frozen after successful independent production-browser verification. The complete core suite passes **811/811**; focused action and server-action authorisation checks pass **248/248** across two files; comparison-source checks pass **4/4**. The database-backed release checks pass **148/148**, with no skips. Exact edits are tested from the genuinely selected Auto producer draft, a directly selected baseline and a Manual source, including repeat-target versioning, active-task refusal, foreign ownership, pending-instruction metadata and stale/reused request identities. The comparison resolver validates the immediate parent when that is the actual edited source, while retaining original Auto lineage as factual dependency authority.

The latest focused Refine/role component tests pass **17/17**, including prefilled unchanged wording, two successive one-action exact saves, hidden exact/instruction buffers, absence of redundant Apply for already-applied exact edits, failed-save recovery with the same retry key, an explicit server-rendered label for the prefilled textarea, and own-save handover preserving the selected bullet/instruction and independently unsaved section order. All package and evaluation typechecks pass. The final production build passes, as do all route budgets: workspace **132,807/138,000 gzip bytes**, shared **102,077/104,000**. The complete legacy browser journey passes. The complete web suite passes **1,814/1,814** across 201 files. The final targeted run passes **264/264** across four action/authorisation/component files, including the database case that preserves generated instruction wording and applied metadata while leaving another instruction pending, without tasks, credits or Library writes. The strengthened mode-workspace browser exposed an own-save/refresh typing race; the dedicated handover fix and its two regressions are verified by the latest 17-case component run. The final rebuilt mode-workspace browser passes, including rapid repeat edits. Hosted checks are not yet claimed complete. Human comprehension testing remains unperformed. Existing prompt qualification passes without new provider calls. No migration, deployment or human usability study was performed.


| Acceptance | Completed local proof |
| --- | --- |
| G1 | Action/database and authorisation checks exercise atomic rule + child + selection publication, actual selected Auto producer/direct baseline sources, repeat-target updates, same-intent retry, stale/different intent, foreign ownership and active-task refusals. No model task, credit or Library write is created by an exact save. |
| G2 | The mixed instruction database case preserves generated prose, citations/signposts and applied instruction history, while a separate instruction remains pending. Manual-origin exact edits stay free and do not promote unselected content. |
| G3 | The production browser opens a clean prefilled Summary, changes it with one **Save and update CV · free**, then immediately edits and saves the same target again without another Apply action. The same remembered rule is versioned and previous editions remain available. Component tests cover failed-request retry and own-save handover; the browser also changes history selection while wording is dirty, uses **Restore original saved edition**, and recovers the typed buffer. |
| G4 | The normal browser source-update path uses **Review source changes** without opening advanced selectors, reviews compatibility counts and genuine conflicts, then explicitly carries compatible choices. A repeated preview recognises already-current rules. Carrying choices does not claim to change the current PDF; applying remaining structured choices or generating instructions remains an explicit, correctly priced decision. |
| G5 | One named and visible Current CV surface, an early version-labelled jump, contextual exact editing, secondary remembered choices and meaningful history were inspected on desktop and mobile. Per-item **Forget for future builds** is distinguished from changing saved wording. Optional Check, Layout, generation and approval remain reachable. |
| G6 | The final production build and all route budgets pass; both legacy and strengthened mode browser journeys pass. The latter includes keyboard use at 390px, no overflow or JavaScript errors, guided carry, dirty-source recovery, immutable approved PDF bytes and application attachment. Human comprehension testing remains a separate, unperformed study. |

The final local diagnostic sample measured workspace load **534 ms**, Auto reuse **847 ms**, one-action exact Save **112 ms**, Manual Save **48 ms** and finalisation **64 ms**. These are single local observations, not production service targets or a percentage speed-up. The measured improvement in the exact-edit path is behavioural: one Save replaces Save plus Apply, with no AI or credit use. Final gzip manifest budgets remain **132,807/138,000 bytes** for the workspace and **102,077/104,000** shared. Screenshots of desktop, mobile and source-update states were independently inspected. No provider prompts, paid calls, migrations or production deployment were introduced by this follow-up.

## 13. Remembered bullet titles

An exact bullet refinement can change its short title and body together through the existing free **Save and update CV** action. The title appears above the body in Refine and remains optional. A missing `bulletSignpost` field preserves existing behaviour; a string sets a trimmed, single-line title of at most 60 characters; explicit `null` removes it. Body-only updates retain an already remembered title choice, including removal.

Both fields belong to the same stable bullet target and refinement version. Applying or rebuilding uses that target's existing source mapping; missing or ambiguous targets remain conflicts rather than attaching the title to a different bullet. Title-only edits retain existing citations. Titles are wording, not new evidence. This introduces no model call, prompt change, migration or change to approved PDF bytes.

The existing reset distinction remains: **Forget for future builds** removes the remembered rule without changing the saved CV; **Reset all** returns to the retained Auto result while keeping saved editions. Dirty-buffer protection, source restoration and successful-save handover include the title as well as the body.

Verification completed locally on 10 November 2026: core editing/rebase 15/15, action integration 9/9, Refine component 16/16 and focused worker record/replay 1/1 passed. Core and web typechecks and the production build passed. The existing complete editing-modes browser journey passed, including title/body persistence, explicit title removal, unchanged work/credit counts, finalisation, source recovery and mobile checks. Actual titled and cleared PDF previews were visually inspected; the title prints in bold before the unchanged body and disappears when cleared.

The CV workspace bundle is within its route budget (133,330 / 138,000 gzip bytes). The initial account bundle overrun was resolved by reusing the existing settings form for LinkedIn disconnection: 115,264 → 114,655 gzip bytes, below the unchanged 115,000-byte limit. Server ownership, fresh-session and remaining-sign-in-method checks are unchanged; account data is refreshed only after a successful unlink. All route/shared bundle budgets pass. No deployment or live provider call was performed.

The first hosted run passed the main suite, shuffled tests, worker image, Lighthouse and Vercel; its browser job exposed two stale smoke assumptions inherited from the onboarding change. The smoke now checks the actual import heading and requires the stronger `no-referrer` and `private, no-store` headers on sensitive authentication pages, retaining ordinary-page checks. The complete local smoke passed after this correction. Follow-up shared-form tests (9/9), LinkedIn action integration (4/4), release-script contract checks (33/33), bundle checks (6/6), web typecheck and production build pass. Final hosted verification remains pending.
