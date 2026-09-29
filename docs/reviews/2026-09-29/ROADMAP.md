# AVA — roadmap to sufficient JTBD completeness

29 September 2026 · baseline `ebb346b` · companion to [JTBD readiness review](JTBD-READINESS.md)

The objective is to move every canonical job to at least **4/5 completeness, 4/5 robustness and 4/5 UX/UI**, equivalent to a minimum 80/100 readiness score. This is an acceptance target, not a forecast that completing tickets automatically earns it. Re-score against fresh evidence after each wave.

Effort ranges below are initial **engineering person-days**, including focused regression checks, not elapsed-time commitments. They assume familiarity with this codebase. Design, participant recruitment, source labelling and provider availability are additional dependencies. Owners are proposed roles, not people already assigned. Paid evaluation scope and spend need to be bounded before execution; this review made no new paid calls.

## Sequence

| Wave | Purpose | Work | Exit decision |
|---|---|---|---|
| A — protect trust | Preserve writing, facts and account intent; make app state truthful | R1–R3; fix CI timing gate in R12 | No known P1 preservation/grounding/state defect in the affected journeys; regressions pass |
| B — make routine work easy | First-use, phone editing, review and application follow-through | R4–R9 | Representative tasks can be completed unaided on desktop and phone; recovery is visible |
| C — qualify the promises | Measure source accuracy, current AI quality and operational recovery | R10–R12; source labelling/recruitment can begin during A | Current, independently reviewable acceptance evidence meets product thresholds |
| D — validate and tune | Observe real people and learning quality; close remaining friction | R13 | Each job reaches its target; limitations and supported envelope are documented |

Do not wait until Wave C to prepare independent labels or recruit people. Do not use that parallel preparation to defer the P1 fixes. Existing supported users may continue giving feedback, but a healthy process snapshot should not be used as a release certificate.

## Work packages

### R1 — Tell the truth about first value and empty results

**Jobs:** J1, J2, J8 · **Priority:** P1 · **Owner:** product engineer with UX · **Effort:** 1–2 days · **Dependencies:** none

- Derive not-started, queued/running, successful-with-matches, successful-zero-matches and blocked/failed from actual source/scan facts.
- Replace the unconditional “Nothing has run yet” with the matching explanation and one useful next action.
- Mark initial monitoring success from an actual completed scan against chosen preferences. Separate “ready to monitor” from “ready to build a CV”.
- Count only relevant active/usable evidence for Library readiness; an archived experience block should not imply that a usable CV foundation exists.

**Accept when:** seeded examples of each state show consistent status strip, empty state, setup milestone and Health destination. A successful zero-match scan says what was checked and offers filter/source inspection. A person can finish monitoring setup before preparing a CV. Add regressions around these state distinctions rather than snapshotting wording alone.

### R2 — Preserve Library writing and employment facts

**Jobs:** J5, J4, J8 · **Priority:** P1 · **Owner:** product engineer · **Effort:** 2–4 days · **Dependencies:** none

- Keep conflicting local fields in an explicit conflict panel with “Use mine / Use saved / Copy both”, or create an actual downloadable draft before replacement. Cover invalid-merge fallback as well as ordinary block conflicts.
- Remove the false “in the download” promise unless that download exists and contains the exact local wording.
- Derive current employment from source evidence. A completed job with a date range must not become Present merely because a model returned `current: true`.
- Keep user review at import acceptance; surface uncertain dates as unknown and explain them.

**Accept when:** two browser tabs can edit the same narrative and recover every local byte after an obsolete save; unrelated edits still merge. Closing/reopening a conflict panel does not lose it. The exact “Mar 2020 – Jun 2022 + current:true” counterexample remains a completed/uncertain role, never Present without supporting evidence. Existing immutable snapshots remain unchanged.

### R3 — Close source-recovery and account-intent races

**Jobs:** J2, J7, J8 · **Priority:** P1/P2 · **Owner:** backend/product engineer · **Effort:** 2–4 days · **Dependencies:** none

- Keep unresolved suspect-empty scans in Needs you and its count until a qualifying successful scan or deliberate resolution. Rediscovery not-found/failed must not clear attention.
- Accept filter suggestions inside one account transaction: check suggestion state, acquire the account lock, read the latest gate, merge, save and resolve. Define behaviour for acceptance racing rejection/deletion as well.
- Fence discovery result persistence against a changed homepage/source context; stale work should be discarded/requeued clearly rather than attached to the corrected company.

**Accept when:** concurrent acceptance of two distinct terms preserves both and admits expected roles; repeated acceptance is idempotent; list/count match for suspect-empty→not-found and suspect-empty→failed; a homepage changed mid-discovery cannot receive the old source. Exercise these interleavings deterministically with barriers, not timing sleeps. User-facing status must remain understandable after recovery.

### R4 — Make Applications a working list for today

**Jobs:** J6, J8 · **Priority:** P2 · **Owner:** product engineer with UX · **Effort:** 2–3 days · **Dependencies:** none

- Add a due/overdue segment or sort that works across the whole account, not just the current page. Link the summary to it.
- Make stage counts actionable filters, combinable with company scope; preserve state in the URL and show selected filters.
- Distinguish application date from stage date and next-action date. Allow genuinely unknown dates. Use local calendar semantics for sensible defaults rather than UTC string slicing.
- Make date provenance clear for imported/historical records; do not rewrite old dates merely to satisfy a form.

**Accept when:** an overdue next action among 60 applications is reachable in one activation and ordered ahead of unrelated work; recording an old interview/rejection does not invent today's submission date; backward changes retain meaningful history; the company view and main view agree. No notification service is necessary for this package.

### R5 — Keep waiting and pricing states current

**Jobs:** J4, J5, J8 · **Priority:** P2 · **Owner:** full-stack engineer · **Effort:** 1–2 days · **Dependencies:** none

- Schedule a client transition or bounded refresh through the import's 15-minute stall threshold, including hidden-tab return, so Dismiss/retry becomes available when promised.
- Recompute the pre-build quote for a pasted advert, or explicitly identify the quote's input and require updated acknowledgement before paid work.
- Present stable explanations for queued, active, awaiting-you, failed, budget-refused and stale results.

**Accept when:** fake-time/component and integrated checks show an untouched stalled import becoming actionable without navigation; edited advert, visible quote and submit-time admission agree within the documented estimation policy. Failed/refused work does not leave an unexplained draft or budget hold.

### R6 — Simplify first-use and company entry

**Jobs:** J1, J2, J7 · **Priority:** P2 · **Owner:** product designer + frontend engineer · **Effort:** 2–3 days · **Dependencies:** R1 state model

- Guide the first visit through preferences → follow an employer → observe first result. Introduce the Library at the CV moment, with an optional earlier import.
- Use plain labels such as “What work are you looking for?” and explain the evidence Library in one sentence.
- Expose the existing multi-homepage action through a textarea with per-item added/already-followed/invalid outcomes. Preserve catalogue search.
- Give Health a direct, named destination from every page; a generic “Settings 3” should not require inference.

**Accept when:** four of five new participants reach a truthful first-result state without guidance, ≤5 minutes active setup excluding asynchronous wait; follow three known URLs in one submission; correctly identify how to fix a blocked source. Registration/verification refusals are visible before avoidable typing.

### R7 — Make the core jobs comfortable on phones

**Jobs:** J1–J6 · **Priority:** P1 for mobile launch, P2 for desktop-only beta · **Owner:** frontend engineer + designer · **Effort:** 4–7 days · **Dependencies:** agree responsive information hierarchy; reuse R1/R4 state model

- Compact global chrome and secondary notices on small screens; keep a clear current-page label and accessible navigation.
- Replace horizontal evidence editing with one responsibility card: narrative, confirmation, type, score, actions in reading order.
- Provide stacked Roles/Companies/Applications items that keep identity, status and primary action together. Preserve desktop tables where comparisons are useful.
- Increase functional text/labels; reserve pixel typography for appropriate branding/headings; make primary touch targets comfortably sized.
- Use one responsive field set where possible. Validate visible controls and show an actionable error summary.

**Accept when:** at 320px and 390px, no core action requires horizontal scrolling to connect it with its item. Test long titles, five-line evidence, error messages, open menus, software-keyboard obstruction, 200% text zoom and reduced motion. Check that primary targets meet the product's 44px intent. Desktop keyboard efficiency must not regress. Document any genuinely tabular exception instead of silently cropping it.

### R8 — Improve review speed and safe correction

**Jobs:** J3, J6 · **Priority:** P2 · **Owner:** frontend/product engineer · **Effort:** 2–3 days · **Dependencies:** R4/R7 where layouts overlap

- Keep active filter chips visible outside collapsed controls; distinguish “Update results” from applying for a job.
- Put decision feedback/undo in the current working area, announce it appropriately, and retain a way to undo recent individual decisions after another action.
- Keep focus meaningful as a row is dismissed, restored, expanded or moved. Align visual keyboard cursor, actual focus and accessible state.
- Make stage summaries lead to the corresponding working list rather than acting as a static legend.

**Accept when:** a keyboard-only and a phone user can review ten roles, explain the filter constraints, undo a deliberate wrong dismissal and continue from a predictable item. Screen-reader output identifies what changed and what can be done next. No inaccessible five-second-only recovery path.

### R9 — Give CV work one obvious next action

**Jobs:** J4, J5 · **Priority:** P2 · **Owner:** product designer + full-stack engineer · **Effort:** 2–4 days · **Dependencies:** R2/R5; current evaluation semantics preserved

- Summarise the current state as ready-to-build, gathering-evidence, building, needs-factual-review, ready-to-finalise or completed.
- Separate required factual corrections from optional coverage/editorial improvements. Put exact evidence/paragraph links beside each actionable issue.
- Keep cost, unsaved edits, assessment freshness and the finalised version understandable without opening process logs.
- Reduce redundant disclosures/tabs only where it makes the task easier; retain details for inspection and troubleshooting.

**Accept when:** first-time users can take a prepared Library and role through build, one correction, reassessment, preview, finalise and download without asking which action to use. They can explain which document is final, what is still unverified and whether the next action costs money. Sharing remains optional and review-only.

### R10 — Prove source and extraction accuracy independently

**Jobs:** J2, J8 · **Priority:** release qualification · **Owner:** data/QA lead + backend engineer · **Effort:** 3–6 engineering days, plus independent labelling · **Dependencies:** R3; frozen source set

- Prepare the SPEC's representative ~25-company set with ATS, custom HTML, JavaScript and protected/unsupported cases. Label the correct source and posting identities independently of AVA's own extractor.
- Run complete current discovery and extraction. Retain exact inputs, expected/observed identities, partial/unavailable cases, confidence and manual-recovery outcomes.
- Re-run narrow fixes in the full set; separate regression fixtures from evidence of general accuracy.

**Accept when:** ≥80% correct automatic discovery at the specified confidence; zero wrong automatic accepts; 100% resolution with one confirmation/paste where the contract requires it; Tier-1 recall/precision ≥98%; Tier-3 recall ≥90% and precision ≥98%; recipe reproduction ≥90%. Keep unresolved cases visible and supported-source claims bounded. These thresholds come from SPEC rather than this review's usability proposals.

### R11 — Qualify current CV, import and ranking quality

**Jobs:** J4, J5, J7 · **Priority:** release qualification for quality claims · **Owner:** AI/product engineer + independent reviewers · **Effort:** 2–4 engineering days, plus reviewer/provider time · **Dependencies:** R2; agreed evaluation corpus and spend ceiling

- Record/replay representative builds at the shipped prompt/model routes. Require a verified report in release qualification rather than treating an unverified report as sufficient.
- Include sparse evidence, career changes, senior multi-role histories, explicit ended jobs, hostile instructions, negation, invented metrics and cross-employer ownership.
- Independently review every printed claim, chronology, final PDF layout and role relevance; blind-compare against an honest baseline. Preserve failures as well as passes.
- Measure import acceptance/correction, claim errors, refusal/recovery, estimated versus observed cost and latency. Evaluate Library review semantics as well as CV prose.
- Start a consented real-decision learning cohort; report the SPEC's 50-decision calibration with bucket denominators and disagreement examples when data is available.

**Accept when:** no unsupported career facts/claims in the release corpus; all configured quality/layout gates pass; independent readers find the output honest and appropriate; current prompt identity is recorded; costs and waits match the interface's stated policy. Real ranking calibration is an honest later gate until sufficient decisions exist, not something synthetic examples can close.

### R12 — Make release qualification and recovery credible

**Jobs:** J9 and all six user jobs · **Priority:** release qualification · **Owner:** platform engineer + named operator Harry · **Effort:** 2–4 engineering days, plus hosted drill time · **Dependencies:** targeted fixes and a release candidate

- Fix the CV replay test's timing assumption using deterministic stage/lease barriers, retaining the real timeout invariant. Obtain a fully green exact-commit CI result.
- Investigate why the assessed commit was deployed while Release was skipped; establish and verify the intended deployment gating policy. Do not infer the cause from health endpoints alone.
- Maintain current web/worker identity checks and exercise the complete user path after deployment.
- Test delivered operational alert receipt, not just a failed/green workflow. Give each signal an actionable destination and owner.
- Attach an isolated managed restore to app and worker; verify account access, Library/drafts, application history and queued-work recovery. Exercise old/new code and schema compatibility or a documented roll-forward recovery.
- Run the agreed hosted 100-account/~10-active envelope with real provider pacing/browser/database pressure. Keep it separate from the very fast local synthetic fixture timings.

**Accept when:** green CI and release evidence name the intended version; an alert is received and acknowledged; recovery meets 24-hour RPO/four-hour RTO with measured evidence; the SPEC 50-company daily run finishes in <15 minutes and failure does not falsely close roles. Other latency/capacity targets require explicit agreement and measurement. Existing managed restore and monitoring work should be extended, not duplicated.

### R13 — Validate outcomes and re-score

**Jobs:** J1–J8; J9 qualified separately through R12 · **Priority:** acceptance · **Owner:** product/UX lead + engineering · **Effort:** 1–2 engineering days for instrumentation/analysis, plus sessions/fixes · **Dependencies:** relevant Wave A/B changes; recruit earlier

- Run five first-time and five returning-user sessions, covering desktop, phone and keyboard/assistive technology.
- Use realistic imperfect inputs and deliberate failure/correction, not a happy-path demo script.
- Record task completion, help requests, wrong turns, time excluding waits, state comprehension and successful recovery. Observe repeat use before claiming that suggestions/ranking improve decisions.
- Re-score with evidence and publish remaining limitations. A missed acceptance criterion returns to its package; it is not closed by an averaged score.

**Accept when:** each canonical job has all three dimensions ≥4, no high-impact unmitigated defect, and explicit evidence for its outcome. Keep operator job J9 as a separate release gate. Learning calibration can remain a clearly stated limited claim until enough genuine decisions exist.

## Per-job completion contract

| Job | Required packages | Evidence required to call it sufficient |
|---|---|---|
| J1 — first value | R1, R6, R7, R13 | New account reaches truthful scan outcome unaided; zero-match and failure states distinguishable; no unnecessary CV prerequisite |
| J2 — reliable watching | R3, R6, R7, R10, R12 | Correct independent sources/posting identities; no false closure under tested failure; prompt actionable recovery |
| J3 — decisions | R7, R8, R13 | Ten-role review and correction without loss/confusion on desktop/phone/keyboard; active filters visible |
| J4 — honest CV | R2, R5, R9, R11, R13 | Current provider evidence and blind review; understandable build→review→finalise; correct final PDF; honest quote/retry states |
| J5 — reusable evidence | R2, R5, R7, R11, R13 | No conflict text loss or false Present import; responsive editing; actionable stalled imports; representative import review |
| J6 — next actions | R4, R7, R8, R13 | Due/overdue work found across pages; dates truthful; stage/company/history agree; quick routine updates |
| J7 — deliberate learning | R3, R6, R11 | Atomic preference acceptance; understandable evidence and reversibility; real calibration reported when sample exists |
| J8 — recover confidently | R1–R5, R6, R13 | Consistent status→explanation→action model; no quiet unresolved exceptions or lost work |
| J9 — service continuity | R12 | Qualified release, delivered alert and full app/worker restore/rollback evidence within agreed objectives |

The task estimates total roughly **26–48 engineering person-days**, with overlapping design/QA/reviewer work and external evidence dependencies. A two-engineer team with part-time product/design/QA could provisionally plan around **4–7 calendar weeks**, then refine after Wave A. This is a planning envelope, not a delivery promise; source/provider discoveries may expand corrective work.

## Scope discipline

Keep the desktop tables, deterministic hard gate, shared daily scan, honest partial-scan handling, immutable CV snapshots and explicit paid review. Do not rebuild the application framework to solve these findings. Automated job submission, LinkedIn crawling, outbound reminders, recruiter CRM and a general CV marketplace are not needed to achieve these jobs. Address the existing outcome gaps before adding them.
