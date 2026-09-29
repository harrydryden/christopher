# AVA — forensic JTBD readiness review

29 September 2026 · assessed commit `ebb346b1fa64e34c16447fffb0d47afbbfd890ac`

**Overall judgement: 68/100. AVA is a substantial working beta, with an especially strong role-review workflow. It is not yet sufficiently dependable and simple across all six jobs for an unqualified wider-release recommendation.** The next investment should close trust and usability gaps in existing journeys. A larger feature inventory would contribute less.

This is a product-engineering assessment of the current implementation, not a percentage of specification tickets completed or a prediction of hiring success. The strongest foundations are deterministic filtering, defensive scan lifecycle rules, account-scoped data, versioned evidence, CV review/finalisation checks and extensive tests. The weakest user outcomes are keeping evidence safe, knowing whether monitoring is truly working, and completing repeated work on a phone.

The local `christopher/main` checkout was fast-forwarded from `9585815` to `ebb346b`. Existing untracked duplicate files were preserved. Evaluation and these artefacts live in the clean `codex/jtbd-forensic-review-20260929` worktree, so duplicate files could not contaminate tests. Three `gpt-6-sol` sub-agents independently reviewed UX, CV/Library, and discovery/reliability; the orchestrator checked their conclusions, ran fresh verification and consolidated the scores. No application code or production data was changed.

## Basis and scoring

The canonical framework is [UX-JOURNEYS.md](../../UX-JOURNEYS.md), Journeys 1–6. Its job statements and definitions of “done” remain useful; its historical “Today” paragraphs were written against a 19 September branch. They are **not** a current defect list. [SPEC.md](../../SPEC.md) supplies the behaviour contract and accuracy thresholds. Later specification decisions take precedence over older suggestions: for example, Library version-history UI and outbound application reminders are not assumed launch requirements.

The assessment follows a JTBD interpretation: judge the progress someone can make in their situation, including their anxiety and recovery needs. A feature counts only insofar as it helps finish that progress. “A next-action field exists” is weaker than “I can reliably find what I owe today”.

Each dimension uses a 0–5 scale:

| Score | Meaning |
|---|---|
| 0 | No usable implementation |
| 1 | Skeleton or isolated demonstration |
| 2 | Partial path, substantial manual work or fragile outcomes |
| 3 | Usable, with material friction or reliability/evidence gaps |
| 4 | Sufficient for the stated audience: complete ordinary path, clear recovery, convincing evidence |
| 5 | Consistently excellent, including representative failure cases and observed user success |

**Completeness** measures whether the whole user outcome can be achieved. **Robustness** includes correctness, preservation of work, asynchronous recovery and the strength of supporting evidence. **UX/UI** measures clarity, effort, discoverability, readability, mobile and keyboard use. Half-points distinguish meaningful intermediate positions.

Readiness = `20 × (0.30 × completeness + 0.30 × robustness + 0.40 × UX/UI)`. UX has the greatest weight deliberately. The overall 68 is the rounded, equally weighted mean of the six canonical jobs; no usage data exists to justify different job weights. The decimals are a transparent judgement aid, not statistical precision. Added jobs below are scored separately to avoid double-counting.

**Sufficient completeness:** target at least 4/5 in every dimension for each job, with no unresolved high-impact correctness or data-loss defect in that path. An average above 80 cannot compensate for a Library that loses text or a monitor that silently watches the wrong source. Representative accuracy, provider quality and recovery gates must also pass before making a broad release claim.

## Scorecard

| Framework job | Complete /5 | Robust /5 | UX/UI /5 | Readiness /100 | Principal constraint |
|---|---:|---:|---:|---:|---|
| J1. Get set up and reach a useful first scan | 4.0 | 3.0 | 3.0 | **66** | Setup records inputs, not successful first value; empty-state explanation can be false |
| J2. Follow companies and reliably receive relevant roles | 4.0 | 2.5 | 3.0 | **63** | Independent accuracy gate remains open; some suspect scans miss actionable Health |
| J3. Review roles and make sound decisions quickly | 4.5 | 4.0 | 3.5 | **79** | Strong desktop workflow; mobile, filter visibility and recovery ergonomics lag |
| J4. Make the strongest honest application | 4.0 | 3.5 | 3.5 | **73** | Strong guarded workflow; live quality at the shipped prompt set is unverified |
| J5. Maintain a safe, reusable evidence Library | 4.0 | 2.5 | 2.5 | **59** | Conflict recovery loses unsaved wording; import can invent current employment; dense mobile editor |
| J6. Know application status and what is owed next | 4.0 | 3.5 | 3.0 | **69** | Next actions are stored but poorly prioritised; date defaults can misstate history |
| **Six-job mean** | **4.1** | **3.2** | **3.1** | **68** | Capability is ahead of dependable, simple use |

Confidence is high in code-traced and locally reproduced behaviours, moderate in the UX scores, and lower in generalised production quality. No representative human usability sessions, screen-reader audit or new paid-model evaluation were conducted. The score does not imply that 32% of the application is missing.

## The most consequential findings

Severity here is product impact: **P1** should be corrected before recommending these paths broadly; **P2** materially affects effectiveness or ease. Release-evidence gates are distinguished from demonstrated application defects.

| ID | Priority and finding | Trigger and user consequence | Evidence / confidence |
|---|---|---|---|
| F1 | **P1: Library recovery can lose writing** | Two tabs edit the same block. The second save is correctly rejected, but “Reload and keep my text” replaces the local conflict with the stored wording. The message promises the discarded text is “in the download”; no such Library download is provided. Unsaved wording was never in a server version. | Direct pure-function reproduction and UI call-chain review; `apps/web/lib/cv-library-merge.ts:73–85,131–155`, `components/CvLibraryEditor.tsx:194–208`. High confidence. |
| F2 | **P1: Import can misstate employment** | Source says `Mar 2020 – Jun 2022`; a model proposal says `current: true`. Validation accepts Current and clears the end date, so the proposal displays Present. User approval remains a mitigation, but the product has failed its grounding promise. | Direct reproduction; `packages/core/src/library-import.ts:348–352,503–510`. High confidence. |
| F3 | **P1: An unresolved suspect-empty source can miss the attention list** | A scan is suspiciously empty, source remains active, and rediscovery returns not-found/failed. The problem is still in recent scan history, but no corresponding Needs you item/count is created. The monitor can look more settled than it is. | Full call-chain review; worker `handlers/scan.ts:905–921`, web `lib/queries/health.ts:1328–1347,1395–1406`. High confidence in this specific state; not an assertion that all failures are hidden. |
| F4 | **P1: Concurrent suggestion acceptance can lose a preference** | Two tabs accept different terms from the same gate version. Each prepares a whole replacement before the settings lock; serial writes can leave only one term while both suggestions are marked accepted. | Traced interleaving; web `app/actions/learning.ts:145–180`, `lib/settings.ts:76–85`. High code confidence; not dynamically concurrency-reproduced in this review. |
| F5 | **P1: First-run messaging can contradict the actual scan state** | No user-role rows and incomplete Library trigger “Nothing has run yet”, even with recent successful scans. Filling a Library is implied to be necessary to receive jobs. Conversely, all five setup inputs can be complete before a scan succeeds. | Local browser fixture and code; `app/(app)/page.tsx:35–40`, `lib/setup.ts:55–57,72–125`, `lib/queries/setup.ts`. High confidence. |
| F6 | **P1 for a mobile launch: primary work requires sideways reading** | At 390px, the Library evidence table is 820px wide inside a 318px container. Narrative, confirmation, type, score and removal are separated. Shared work tables have a 720px minimum. Mobile page chrome and setup can push the first role below the initial viewport. | Measured Chromium DOM and screenshots; `components/CvLibraryEditor.tsx:366–418`, `components/table.tsx:3–8`. High for layout; user impact is expert judgement. |
| F7 | **P2: Application dates can be silently inaccurate** | Moving directly to a later status requires an applied date prefilled with UTC today. Historical updates can record today without the user supplying the actual submission date; local calendar date may differ. | `components/ApplicationsTable.tsx:61–62,145–156`. High code confidence; not a production data audit. |
| F8 | **P2: Due work is not a navigable working queue** | Next-action summary is text; Active/Closed/All and stage-first ordering can leave an overdue action on a later page. Stage totals also do not filter the table. | `app/(app)/applications/page.tsx:115–140`, `lib/queries/applications.ts:611–639`. High confidence. |
| F9 | **P2: Stalled import recovery arrives after polling stops** | Polling stops at 10 minutes; Dismiss becomes available at 15. With unchanged database state, an open tab can continue to say it is reading until navigation/reload. | `components/useVisiblePoll.ts:89–115`, `lib/library-import.ts:103–118`, `lib/queries/library-imports.ts:46–56`. High code confidence; not elapsed-time browser-tested. |
| F10 | **P2: A pasted replacement advert does not update the visible quote** | Build shows a quote based on the stored advert; submit recalculates using pasted text and can refuse it. The budget guard works, but the promise before clicking is stale. | `components/ApplicationsTable.tsx:206–238`, `app/actions/cv.ts:375–406`. High code confidence. |
| F11 | **P2: In-flight discovery can attach an old homepage's source after correction** | Admin corrects a homepage while discovery fetches the previous site. Result persistence lacks the homepage comparison used by the logo path. A late result can affect all followers. | `app/actions/admin.ts:46–54`, worker `handlers/discover.ts:70–75,127–188`; full chain reviewed. High code confidence; dynamic race test still required. |

Detailed reproductions, mitigations and source references are in [CV/Library review](cv-evidence-review.md), [discovery/reliability review](discovery-reliability-review.md) and [UX review](ux-review.md).

One initial concern was **not** promoted to a blocking defect: the responsive employment form duplicates required controls, but Chromium mobile moved focus to the visible title field after an incomplete save, with no JavaScript error. Validation explanation and assistive-technology behaviour still merit improvement. This illustrates why static suspicion and observed failure are kept separate.

## J1 — Get set up and reach first value

**User progress:** “Get AVA watching the right companies for the right roles, with enough about me that ranking and CVs are mine.” The framework defines success as a first scan against chosen filters and an understanding of what happens next. The emotional job is confidence that an empty screen has an understandable reason.

**Implemented:** five account-derived setup milestones, links to specific fields, email-verification explanations, user-chosen filters before following companies, seed profile, import options and setup guidance. This is a considerable improvement over the original framework audit. Core account and unauthorised-access paths have tests; the current app renders the setup states in the built smoke journey.

**Remaining:** setup completion is based on saved inputs. It does not verify a resolved source or successful first scan. Library readiness is mixed with the earlier task of seeing relevant roles. Asking for three companies is a useful suggestion, but is not itself evidence of value. The Companies milestone points into Discover, where entering multiple known homepages is less direct than the action implementation permits. “Seed profile” and “Library” require learning the product's vocabulary before the value is clear.

**Sufficient outcome:** after choosing role/location preferences and following one real company, the user sees either relevant roles or a truthful explanation of zero matches, with source freshness and one next action. Library setup should become the next step when the user wants a CV, rather than a prerequisite implied by monitoring copy.

**Roadmap:** R1 fixes truthful first-value states; R6 reorganises the first-use flow and bulk company entry; R7 reduces mobile navigation overhead. Test a new verified user, unverified user, source awaiting confirmation, failed scan, and successful zero-match scan. Proposed usability target: at least four of five new participants complete setup unaided, with ≤5 minutes active setup excluding external waits, and can accurately explain what happens next. This is a proposed target, not a measured baseline.

## J2 — Follow companies and receive trustworthy relevant roles

**User progress:** “Tell AVA who I am interested in and let it find their roles reliably, without babysitting it.” Done includes a correct source, completed scan, understandable filters and a recovery path when watching breaks.

**Implemented:** shared catalogue and daily scans, ATS-first discovery, candidate confirmation, direct URL recovery, setup timeline, elapsed/expected timing, next scan information, complete/partial/suspect handling, and defensive closure only after qualifying misses. Hard filtering stays user-controlled. Health has inline resolution controls. Company management has clearer pause/archive/follow distinctions than older audits describe.

**Remaining:** independent current accuracy is the weakest part of the promise. The latest full 25-case browser observation in the repository reported 60% labelled automatic agreement; it lacks the independently labelled posting identities needed to establish extraction recall/precision. Narrow fixes and machine-derived regression oracles are useful, but do not close that gate. This historical result does **not** establish a current 40% production failure rate. F3 and F11 are specific reliability gaps in recovery and source correction.

**Sufficient outcome:** company source and freshness are explicit; suspicious emptiness remains actionable until resolved; all follow/filter/recovery paths preserve account intent; a frozen, independently labelled acceptance set meets SPEC thresholds. The user can understand and fix the common failures without an operator explaining task states.

**Roadmap:** R3 fixes recovery/state races; R6 restores simple multi-company entry and direct Health access; R10 supplies independent source/extraction acceptance. Use the SPEC's ≥80% correct automatic discovery, zero wrong automatic accepts, 100% resolution with one confirmation/pasted URL, Tier-1 ≥98% recall/precision, Tier-3 ≥90% recall and ≥98% precision, and ≥90% recipe reproduction. Record denominator, source identities, date, commit and exclusions. Do not relabel a missing page as a zero-job company.

## J3 — Review roles and decide quickly

**User progress:** “Get through today's roles, make a sound apply-or-pass decision, and have AVA learn from it.” Done means a real shortlist and reasons behind dismissals, without accidental loss.

**Implemented:** Matched/Shortlisted/Dismissed workflow, stored advert text, matching keywords and location explanation, salary, fit rationale, quick dismissal reasons, keyboard shortcuts, optimistic decisions, undo/reconsider, archive/restore and hand-off into Applications. This is the strongest current journey. The fresh local browser walkthrough confirmed that expanding a role presents the basis for the decision rather than only a score.

**Remaining:** the mobile table separates context and action; compact typography makes scanability harder; active advanced filters can be hidden inside “More filters”. A five-second single-item Undo below the table can be missed or replaced in a fast review session, although reconsider remains available. Keyboard cursor styling is not equivalent to a complete screen-reader/focus model. “Apply” on the filter form is ambiguous in a job application product.

**Sufficient outcome:** on desktop and phone, the person can see role, company, location, fit basis and the primary decision together. Active filters stay visible. Every decision has clear feedback and an accessible way back. A later action does not unexpectedly eliminate recovery for the previous one.

**Roadmap:** R7 creates responsive role cards and clearer typography/targets; R8 improves filter chips, undo placement/history and focus continuity. Preserve the efficient desktop table and shortcuts. Proposed test: review ten representative roles with no moderator intervention, correctly explain the basis for two decisions, and recover one mistaken dismissal. Measure median decision time and error rate; do not infer speed from the number of shortcuts alone.

## J4 — Produce the strongest honest application

**User progress:** turn a shortlisted role and real evidence into an appropriate CV, understand its gaps, incorporate feedback and download the exact final document intended for submission. The anxiety is making unsupported claims or sending the wrong version.

**Implemented:** role-specific build, confirmed evidence requirements, budget admission, pre-build estimate, quiz/tailoring continuation, stage narration, error recovery, direct edits, rebuild/reassessment, factual evaluation, gap links to Library, measured page fitting, finalisation checks, selectable-text PDF, sharing with expiry/revocation and anchored comments. The built browser smoke passed substantial CV and tailoring interactions. Finalisation guards and immutable snapshots are valuable strengths.

**Remaining:** code-level safety and a scripted grade cannot establish semantic quality. The current shipped prompt set `e06dce7dc560` has no committed verified live evaluation; the report gate warns but passes by default. Historical paid-provider evaluations exist and must be credited, but they cannot certify changed prompts. F10 creates a cost-expectation mismatch after pasting an advert. The workspace has enough tabs, disclosures, scores and build language that a new user still needs to infer which action matters next.

**Sufficient outcome:** one obvious progression — review evidence → build → resolve factual problems/gaps → preview → finalise/download. The person can distinguish required factual corrections from optional improvement, can see what a new operation costs, and can recover from failure without guessing whether a draft or charge is final. Representative blind review confirms honest, suitable, readable outputs from the current model/prompt configuration.

**Roadmap:** R5 corrects quotes and stale async states; R9 provides one next-action summary with secondary technical detail; R11 validates current provider quality. Assess CVs for unsupported claims, preserved career chronology, role relevance, page fit and human readability. Publish cost/latency distributions and refusal/retry outcomes. A score of 100 from the same model ecosystem is not a substitute for independent factual and editorial review.

## J5 — Maintain the evidence Library safely

**User progress:** keep one honest record of experience that can be reused and improved without repeating data entry or losing work. This is both a task in its own right and a dependency of J4.

**Implemented:** employment records, responsibility rows, confirmation, evidence categories and guidance, rules-based feedback, optional paid re-score, PDF/DOCX/paste/site import, proposals requiring acceptance, archived-job restoration, immutable saved versions, stale-write rejection, unsaved-change banner and navigation guard. Ordinary save does not silently incur a paid review. The current specification intentionally removed the old version-history surface; it is not counted as missing work.

**Remaining:** F1 breaks the “keep my text” promise at exactly the point the user is trying to recover. F2 permits a concrete unsupported career fact. F9 leaves stalled import recovery stale in an open tab. The responsibilities editor places several concepts in a wide grid and asks the user to manage text, confirmation, types and scores concurrently. This is the lowest-scoring job because the user's most valuable writing is at risk and repeated editing is difficult on a phone.

**Sufficient outcome:** importing never silently changes a completed job to current; every local edit survives a conflict in an accessible draft/conflict panel; all import states become actionable without reopening the page; the user can add, confirm and improve one job using a single vertically readable group on a phone. Evidence quality guidance should appear beside the row that can be improved.

**Roadmap:** R2 repairs preservation and grounding first, R5 closes import waiting/recovery, R7 restructures mobile rows, and R11 adds representative import/review quality evaluation. Test two concurrent editors, malformed/hostile/sparse CVs, explicit ended employment, duplicate imports, obsolete Library versions and worker interruption. Proposed task target: at least four of five participants import a CV, spot one incorrect proposal, correct it, add one evidence row and save without losing or unknowingly changing facts.

## J6 — Know application status and what to do next

**User progress:** know where every application stands, what is owed next and what happened, without maintaining another spreadsheet.

**Implemented:** a single pipeline with application statuses, CV links, dated stage history, notes, next actions, stale hints, outcome signals, backward-transition confirmation, company scope, SQL pagination and archive/restore. These are meaningful improvements over the historical framework. Browser smoke covers stage and CV controls plus archive/restore/delete.

**Remaining:** the interface is better at recording history than running the day's work. A textual due summary does not locate the rows behind it, stage counts do not filter, and stage-first ordering is not deadline-first ordering. A later-stage entry may prefill a submission date the user never supplied. The broad Active/Closed/All segmentation provides insufficient precision for a larger pipeline.

**Sufficient outcome:** one activation reveals every overdue/today item across pages, sorted by urgency with role/company context. Stage and company filters combine predictably. Unknown application dates remain unknown rather than becoming today. The user can explain what to do next immediately on entering the page.

**Roadmap:** R4 fixes date semantics and introduces due/overdue filtering; R7 supplies a compact mobile pipeline; R8 makes stage summaries actionable. Proposed test: find an overdue interview follow-up hidden among 60 applications in ≤15 seconds, record its outcome and next action, then find it from the company view. No outbound reminder system is required to achieve this within the app; notifications remain outside the current product contract.

## UX and UI: what to preserve and what to change

The design is coherent: green navigation, restrained colours, high-contrast content, predictable rectangular controls and a shared component system. Strong contrast, status words alongside colour and reduced-motion handling are assets. The issue is not absence of visual identity. The problem is that too much of the identity is applied to small functional text, while task priority is insufficiently expressed.

### 1. Put the user's next decision above product machinery

On the 390×844 Roles screenshot, global navigation/status occupies roughly 292px. Setup, suggestions, tabs and filters then fill the remaining first viewport before any role is visible. This is a specific seeded first-use state, not every return visit, but it is precisely when a new user is learning the app. Compact the phone header, collapse completed setup to a sentence, and make suggestions secondary to the current review task. On CV, show “Resolve 2 factual checks” or “Ready to download” before process logs.

### 2. Use readable type and real touch targets for work

The design specification uses 9px table headings, 10px field labels and 11px navigation; some small buttons are around 26px high despite its declared 44px hit-target intention. The pixel face works as branding but is less suitable for instructions and dense controls. Retain it selectively for identity/headings; increase functional labels and provide comfortable 44px primary targets. Check actual rendered contrast, zoom and focus rather than assuming token intent certifies accessibility. A formal WCAG audit was not performed.

### 3. Make one work item understandable without sideways travel

At phone widths, present company/role/status/next action in a card or stacked row. For evidence, put narrative first, confirmation immediately below, then type/score as secondary controls. Preserve the table for wide-screen comparison. The measured Library example shows local scrolling, not whole-page overflow: the page width stays 390px while the 820px evidence table sits in a 318px viewport. Avoid claiming that simply removing page overflow fixes this task.

### 4. Keep constraints and recovery visible

Show active filter chips even when the editing controls are collapsed. Rename filter “Apply” to “Update results”. Label the first-use profile with a plain phrase such as “What work are you looking for?”. Name Health directly where its count appears. Keep undo next to the action/result, with sufficient time and an accessible history. Give error summaries `role="alert"`/appropriate live semantics and focus the first visible invalid field with an explanation; do not rely on a visual border or a toast outside the viewport.

### 5. Explain scores as decision aids

Distinguish deterministic eligibility, estimated role fit, evidence completeness and factual CV review. The same visual prominence should not imply the same certainty. State what caused an unscored/refused/stale result and how to fix it. Place supporting detail behind an understandable summary while keeping necessary factual warnings prominent.

### 6. Test complete tasks with people

The smoke suite is unusually broad, but it proves that scripted interactions work. It does not prove that someone knows which interaction to choose. Run five moderated first-time sessions and five returning-user sessions across desktop and phone; include keyboard-only and assistive-technology sessions. Measure unaided completion, wrong turns, time excluding asynchronous waits, correction/recovery success and whether users can describe the current state. The initial targets above should be adjusted from observations, not presented as established performance.

Visual evidence:

- [Desktop Roles](evidence/roles-desktop.png) — coherent hierarchy, but small labels and multiple competing strips.
- [390px Roles](evidence/roles-mobile.png) — first role below the initial viewport in this setup state.
- [390px Library evidence](evidence/library-mobile.png) — the narrative and neighbouring controls do not fit together.
- [Successful prior scan with empty views](evidence/empty-after-scan.png) — “Last scan 6m ago” and “Nothing has run yet” coexist. This was constructed by clearing only the disposable demo account's role views while retaining seeded successful scans, not observed on a production account.

## Jobs underrepresented in the framework

These are extensions of the product outcome, not a recommendation to build unrelated features. They should have explicit owners and acceptance criteria rather than being buried in implementation work.

| Added job | Complete /5 | Robust /5 | UX/UI /5 | Readiness | Why make it explicit? |
|---|---:|---:|---:|---:|---|
| J7. Teach AVA what I want and widen my search deliberately | 4 | 3 | 3 | **66** | Learning/profile editing, filter proposals and verified employer suggestions exist, but real-decision calibration is unproven and concurrent acceptance can lose intent. Track as its own outcome across J2/J3. |
| J8. Know when AVA needs me and recover without losing progress | 4 | 3 | 2.5 | **62** | Health, retries and progress exist, but suspect scans, stale import waiting, indirect Health navigation and conflict recovery show that exceptions need a coherent user journey. |
| J9. Keep my work available through service failure and release changes | 3.5 | 2.5 | 3 | **60** | This supporting operator job protects every user journey. Monitoring, backup restoration evidence and release identity checks exist; complete application recovery/rollback and delivered alert evidence remain open. UX here means operator clarity and recoverability. |

J7 is sufficient when preference changes are atomic and reversible, suggestions say why they help, and SPEC calibration is reported after 50 real decisions with ≥75% agreement in both high/low buckets and honest denominators. J8 is sufficient when every pending/blocked/failed/stale state has one truthful explanation and a reachable recovery action that preserves work. J9 is sufficient when a restored app and worker meet the documented 24-hour RPO and four-hour RTO, and the named owner receives and acts on an exercised alert.

## Release evidence and limitations

Current public web and worker health endpoints both reported `ok: true` and exact commit `ebb346b` during this review. That proves reachable processes and matching identities at one observation, not six successful production jobs.

The [current commit's CI run](https://github.com/harrydryden/christopher/actions/runs/36485054175) failed only in order-independence: the CV replay timeout test expected elapsed time >100ms but observed 83ms. Its preceding `outcome === published` assertion passed. The check, browser-and-smoke, worker-image and Lighthouse jobs passed. [Release](https://github.com/harrydryden/christopher/actions/runs/36486124405) was skipped. Thus deployed identity and green release qualification have diverged; inspect deployment policy rather than assuming the workflow gated this deployment. The cause of the deployment was not established here.

The [latest inspected operational run](https://github.com/harrydryden/christopher/actions/runs/36542834769) passed, reporting no ready/running work or crash recoveries and no provider calls in its one-hour window. An idle healthy snapshot does not establish loaded provider performance or notification delivery. Older statements that there is no operational monitor or no managed restore evidence are now inaccurate: [RELEASE-GATES.md](../../RELEASE-GATES.md) records both, including a partial managed restore. The remaining requirement is to restore and exercise the application/worker and prove alert receipt, not to start those capabilities from nothing.

The current evaluation gate reports that all committed reports for prompt set `e06dce7dc560` are unverified, and that the tailoring report names no prompt set. It passes with a warning unless strict verified evidence is required. A report can be structurally current without establishing current model quality.

See [verification record](VERIFICATION.md) for fresh commands, exact test counts and limitations. No production account journey, new external careers crawl, paid AI run, live email/OAuth flow, hosted load test, complete recovery drill or human usability study was performed. No secrets were copied into the review artefacts.

## Decision and next investment

Keep AVA in a bounded, supported beta while correcting the specific preservation/grounding/state defects. Target **≥80 per job, with all three dimensions ≥4**, before describing all six journeys as sufficiently complete. The acceptance gates are outcomes, not a demand for every historical suggestion or a 5/5 score.

Start with Library trust and truthful state, then make the repeated phone and desktop tasks easier, while gathering independent source and current-provider evidence. Retain the strong existing workflow and safety controls. The detailed, sequenced plan, owners, effort ranges and per-job exit gates are in [ROADMAP.md](ROADMAP.md).
