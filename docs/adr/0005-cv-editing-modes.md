# ADR 0005 — Stable Auto CVs, role refinements and independent Manual editions

Status: Accepted and implemented, 2 November 2026. Local verification and synthetic live qualification complete; hosted review/CI pending. No production migration or rollout has occurred.

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

Follow-up verification passes: production build, all route bundle budgets, seven mode-component tests, six bundle tests, web typecheck, both complete browser journeys and **148/148 release-script tests**. This last isolated run exercises the benchmark case skipped by the earlier retained-database run. Only the two databases created for this follow-up were removed, and the retained PostgreSQL container was restored to its original stopped state. No prompts, migrations or provider calls changed. The follow-up hosted rerun remains pending; no production deployment is claimed.
