# Course of Life — frontend JTBD design review

6 October 2026 · source baseline `b5d6acb` on latest `origin/main`

**The application can do considerably more than its interface makes easy. The largest improvement is to turn evidence collection and CV review into guided decisions, then reduce the controls and explanations surrounding them.** Retain the green identity, efficient desktop lists, evidence provenance and user control. Give the user's current task the most space and emphasis.

This is an expert design evaluation, orchestrated by Astra with three independent Sol audits. It is not a new engineering-readiness score or a claim that the earlier 90-point targets have been verified. The six jobs in [UX-JOURNEYS.md](../../UX-JOURNEYS.md) remain the framework; that document's dated “Today” descriptions are historical, not a current defect list.

## Evidence and scope

**Observed live:** authenticated desktop Roles, Experience/Library (Intro and employment/evidence editing), Companies, Applications, Account, and two saved CV workspaces, including their Evaluation tabs. A narrow viewport inspection covered Roles and a finalised CV. The browser's requested 390px override produced a measured 487 CSS-pixel viewport in this session; this is a narrow-layout inspection, not a certified 390px test. The override was reset.

**Source inspected:** all six journeys, shared navigation/design tokens, onboarding states, manual role import, Discover, evidence scoring/confirmation, CV review/finalisation/download, application updates and billing. Three Sol agents checked separate journeys; the orchestrator inspected live screens and reconciled the findings.

**Not tested here:** new-user usability with participants, screen-reader operation, every empty/error state, production mutations, paid model calls, checkout or CV generation. The live deployment commit was not independently established; source claims refer to the fetched main commit above. Private account content is not reproduced in this report. Recommendations and proposed success criteria are explicitly future work.

The only application changes in this review are **Library → Experience** in the shared desktop/mobile navigation, destination heading and accessible tab-group label, plus the existing test expectations. Routes, stored data and other product wording are unchanged. The interactive design example is separate from the application.

## Assessment by job

| Job and definition of success | Current strengths | Principal remaining friction | Design direction / priority |
|---|---|---|---|
| **J1 — Start receiving useful roles.** Set preferences, follow a company and understand the first result or wait. | Setup now tracks four meaningful outcomes, including a successful first scan. Evidence setup does not block monitoring. | The Roles introduction promotes adding a link/PDF and building a CV even for a returning monitoring user. An unverified user can fill the manual-import form before submission refuses it. | Make onboarding follow the user's starting intent; show verification constraints before work. **High.** |
| **J2 — Monitor companies confidently.** Know monitoring is working and fix exceptions without administration. | Source timelines, last checks, Health resolutions, company role counts and follow-management disclosures exist. | The primary Companies table dedicates a column to provider names such as Ashby/HTML. The global status strip advertises unrelated monitoring work while writing a CV. | Lead with relevant roles and freshness; disclose source technology. Surface exceptions without a permanent operational dashboard. **Medium.** |
| **J3 — Decide which roles to pursue.** Read enough context, shortlist/dismiss and recover a mistake. | Role detail includes advert, match reasons, salary and decisions; undo, active-filter summaries and shortcuts exist. | Filters occupy more space than the observed single result. Narrow cards place Review above company/title and waste vertical space. Labels and card layout use different breakpoints. | Compact filter toolbar; identity and match reason first, decisions together. **High.** |
| **J4 — Produce an accurate, tailored CV.** Add relevant evidence, review, preview and obtain the intended final document. | Questions, progress, direct edits, skill controls, guided findings, dismissal/override, preview and sharing exist. | Too many competing actions and quality measures. Raw quiz answers go straight into evidence without a draft-writing step. A finalised CV still asks for assessment, giving contradictory instructions. | One next action per state; guided review as default; reusable evidence conversation; truthful finalised recovery. **Highest.** |
| **J5 — Maintain reusable career evidence.** Record real experience once and improve it with minimal writing effort. | Imports, confirmation, versioning, unsaved-change recovery, responsive rows and archived-job restore exist. | Employment details and evidence are edited in separate long structures. Taxonomy, row scores and confirmation compete with the narrative. Questions merely create empty rows. | One card per job and **question → answer → draft → confirm**. **Highest.** |
| **J6 — Know what to do next with applications.** Find due work, record progress and keep the correct CV attached. | Stage/due filters, dates, next steps, history and CV links are present. | Three parallel sets of filters precede the list. Editing status reveals many fields at once; the role title is the entry to that form. | Lead with due work and a visible “Update” action; reveal fields appropriate to the event. **Medium.** |

Supporting jobs deserve explicit design attention: **understand and control spending**, **recover without losing work**, and **resume where I stopped**. They cut across the six journeys; separate screens are not necessarily needed.

## Fix these specific inconsistencies first

These are more concrete than aesthetic preferences.

1. **A finalised CV can promise a download while requiring an assessment it cannot run.** This was observed on a saved CV: “Download your final CV” above “Assessment required”, with no assessment action. `CvAssessmentPanel.tsx:73–99` shows the generic missing/stale assessment state but hides reassessment for finalised drafts. `cv-next-action.ts:18–21` prioritises finalised status. The PDF route checks current finalisability before reading stored PDF bytes (`app/api/cv/[id]/pdf/route.ts:23–42`), so the same state has a code-traced download risk. The attempted browser download was blocked by the browser client, so an HTTP failure was **not** verified live. Determine whether the saved assessment is missing, an older version, or a hash mismatch; a later Experience version alone does not explain this because currentness uses the frozen snapshot. Prefer preserving access to an already-finalised immutable PDF, with a separate revision for a new assessment. Where no valid artefact exists, explain the recovery explicitly. This requires an intentional lifecycle decision and regression tests, not merely changing the banner.
2. **Manual role import discovers verification too late.** `roles/add/page.tsx:10–16` exposes the form; `actions/role-import.ts:67–71` requires verification on submission. Place the same verification notice and resend action before the form, preserving entered work if verification expires. Include this action in the shared verification explanation.
3. **Narrow role cards have inconsistent labels and order.** `RolesTable.module.css:5–32` uses a container breakpoint, while `RolesTable.tsx:298–315` hides Location/Fit labels using a viewport breakpoint. Use one layout condition. Put company/title before Review in both visual and DOM reading order; avoid fixing the visual order while leaving keyboard order confusing.
4. **Filter explanations should describe the actual rules.** `lib/setup.ts:54` says title-only while Settings allows title, department and description. Generate the sentence from the selected fields. `RolesFilterBar.tsx:64–105` hides availability with the mobile filter body; keep selected availability evident and its quick controls readily reachable.

## The highest-impact redesign: Experience

### What is happening now

The live page opens on contact details and a biography. It leads with “Rows changed since the last review”, Re-score, “Ready to build: yes” and an evidence rating before the tabs. Under Experience, a full employment grid precedes another set of job fieldsets. Each evidence row has a number, confirmation checkbox, narrative, type menu, score and removal action. Textareas truncate long narratives into small scrolling areas while their controls remain permanently visible.

The missing-evidence advice is already clickable and accessible by touch/keyboard: `RowScoreButton.tsx` uses a dialogue, not merely a hover tooltip. The problem is what follows. `EvidenceSummary` in `EvidenceScore.tsx` offers questions and “Add a row for this”; `CvLibraryEditor.tsx:313–340` adds a blank row with a suggested facet, and `:527` uses the question as its placeholder. The user still has to interpret the rubric and compose finished evidence.

### Proposed page

Start with **Experience**, a short readiness sentence only when useful, and **Add experience** / **Import CV**. An empty account should see the import/start choices before a large form. A returning user should return to the last job they were improving.

Use **Work history · Education & skills · About you** as the main sections. Put the scoring guide under “How evidence is reviewed”, and writing preferences under a secondary disclosure. “Work history” prevents an Experience page containing an identically named Experience tab. One job card owns its title, employer, dates and evidence; “Edit job details” opens those fields in place. Collapsed cards show the job, dates, confirmed-example count and at most one useful prompt. Keep an efficient direct-edit view for bulk users.

Each job's expanded card should lead with a useful question, not its score. For example, **“What changed because of your work?”** Supporting text can say **“A result is useful even if you do not have a number.”** Scores remain available behind “Review evidence”; they must not become a completion quota. A fact can be confirmed yet need more context, so use **“Confirmed · could use a result”**, rather than making users reconcile a tick and a low score.

### The interaction contract

| Step | User sees and does | System behaviour / guard |
|---|---|---|
| **1. Ask** | One question with the relevant job and a brief reason. “Answer”, “Skip for now”, “Nothing to add”. | Choose a material gap from existing evidence; avoid asking what is already answered. Prioritise recent/relevant experience over making every old job cover all six types. |
| **2. Answer** | Plain-language notes in a generous field. Optional result, scope or timeframe only where relevant. | Retain the answer through back/retry/navigation. Do not require a metric. Do not insert prompt instructions into canonical evidence. |
| **3. Draft** | Proposed wording, editable, with the original answer available for comparison. “Use my answer as written” is available. | Use only the answer and identified existing facts. Preserve “we” versus “I”, contribution versus ownership, approximations and uncertainty. If a claim lacks support, ask a follow-up rather than completing it. |
| **4. Confirm and save** | Exact wording and destination: “Save to Operations lead · Example Company”. A clear affirmative action confirms this wording. | Save a new evidence version through existing concurrency guards. Never auto-confirm a model draft. A rejected draft leaves saved evidence unchanged. Handle current unsaved edits explicitly without overwriting them. |
| **5. Continue or finish** | “Saved to Experience” and the next worthwhile question, or “Done for now”. | Recompute local indicators immediately; mark AI review pending/outdated separately. Preserve the user's place. Do not immediately re-ask a dismissed question for unchanged evidence. |

Illustrative example, **not** an account fact: answer “We reduced weekly reporting from two days to half a day using a shared dashboard” can become “Helped reduce weekly reporting from two days to half a day using a shared dashboard”, after clarifying the person's contribution if necessary. It must not become “Led a company-wide transformation” or gain an invented financial result. The separate design example demonstrates the interaction with sample data; it does not call a model or save to the application.

**Reuse this loop in the pre-build quiz and CV gap review.** A role requirement supplies the question context; the person selects the actual job or skill evidence destination, reviews wording, saves, and returns to the same CV/finding. Keep the existing “No further evidence — continue” path. Skipping or dismissing a gap records a decision; it does not upgrade its factual status or inflate the score.

### Compatibility and targeted refactor

The existing foundation supports this direction. Experience rows live under a job, facets describe their type, confirmation is tied to exact wording, and only confirmed experience reaches CV generation (`packages/core/src/cv.ts:110–166`, `cv-helpers.ts:247–295`). Imports already separate proposals from accepted evidence. The quiz already has destination selection, explicit accuracy confirmation and versioned continuation (`actions/cv.ts:186–300`).

A **focused refactor is warranted**: extract a shared evidence-conversation controller and presentation from the large editor and quiz. Keep question/answer/proposed wording separate from canonical evidence until acceptance. Carry the question ID, target entry, base version and source wording through draft and save; cancel or reject stale responses. Commit once, idempotently, through the existing ownership/version checks. If pending answers survive navigation, store them as pending answers with a clear resume/delete path, not as confirmed narrative.

System drafting is a new bounded capability: it needs an action/worker path, budget handling, grounding checks and evaluation fixtures. It is not a replacement label for Re-score. Use the same completion/retry/error interaction as existing asynchronous work; retain a no-model “Use answer as written” route. Do not spend a CV-build credit without a disclosed pricing decision. Re-score should be coalesced after accepted changes, not called on every keystroke. Initially preserve the explicit review action if automatic review cost is not yet agreed.

**Keep the CV semantics distinct.** Skills are concise labels; skill detail is supporting evidence available to the matching/writing process; job experience carries actions and results in context. Do not automatically print detailed skill prose again beside the skills pills. Offer a suggestion to link related evidence, and prevent the same claim being repeated across summary, skills detail and experience simply to satisfy several scores. Existing limits, one pill per skill, section headings and PDF pagination should remain unchanged by this UI work.

## Simplify the CV workspace around the saved revision

Use **Write · Review · Appearance**, with a persistent Preview and a single state-appropriate primary action. The current Next action component is useful; merge its action into the workspace command area instead of repeating a large banner and the same header button. The observed finalised view presents Download twice and continues to show Save/Rebuild explanations.

| State | Primary action | Secondary actions and explanation |
|---|---|---|
| Unsaved edits | **Save and check** | Preview current edits; one sentence explaining that preview includes unsaved text. Preserve exact user wording. |
| Saved, not assessed | **Check this CV** | Preview; “Rewrite from Experience · 1 credit” under More. Keep any applicable cost visible before commitment. |
| Assessed with findings | **Review 3 items** (actual count) | Preview; explicit “Finalise anyway” remains accessible. Show the findings and consequences before final confirmation. |
| Ready | **Finalise CV** | Preview; Edit. |
| Finalised | **Download PDF** | Preview, Share, Create a new revision. If retrieval is unavailable, show recovery instead of promising success. |
| Building or failed | **Current stage / Retry** | Preserve inputs and completed work; detailed attempt log behind “Build details”. |

The current guided review is a strong foundation. Make it the default content of Review: factual concerns first, then essential gaps, then optional refinements. Show **“2 of 7 reviewed”** with Previous/Next rather than a button for every finding plus another set of table filter chips. Keep “Nothing further to add”, edit/evidence links and an explicit override. Put the full assessment table and individual scoring dimensions behind “View full assessment”. One summary of outstanding work matters more than seven equally prominent measures. Scores should inform a decision, not compete to define completion.

Job description should be a contextual reference: show the relevant requirement beside the question/finding; offer the full advert on demand. Preserve the ability to pin it alongside writing. Do not make users read the employer's introduction on every edit.

## Other journey improvements

### Roles and first use

Offer two starting intentions in the initial empty state: **Find roles at companies I follow** and **I already have a role**. Reuse the existing four-step monitoring setup for the former and link/PDF import for the latter. The latter should lead into Experience import only when CV evidence is needed. Keep the manual feature visible as **Add a role · Link or PDF**, without making it the permanent explanation of the entire Roles page.

Use a compact row for company/title filters, a **Filters** disclosure with an active count, and always-visible applied chips. Show Clear only when a filter is active. Preserve deliberate Update results if required by the existing search flow; do not introduce surprising requests on every keypress. Keep availability evident when the advanced panel closes.

A narrow role card should read **role → company/location → match reason → Review/Shortlist/Dismiss**, with selection secondary. The current card's generous isolated cells produce almost an entire screen for one role. Reduce space between related lines, not the touch target. Show keyboard shortcuts under a Help disclosure on touch layouts. Retain the desktop table and keyboard speed.

### Companies and exceptions

Lead the list with **Company · Roles to review · Monitoring · Manage**. Put provider/source implementation details in “Monitoring details”. Say “Checked today” or “Needs attention”, retaining exact times on expansion. Preserve open and shortlisted counts through the row or company view. Move lengthy suggestion source quotes behind “Why this company?” while keeping a one-line reason visible.

Keep Health reachable and exceptions prominent. A label such as **Monitoring** is clearer than Health if it continues to focus on watched sources; if broader account failures remain there, use **Needs attention** with an accurate count. Do not collapse unresolved problems into a reassuring green overall status. On CV/Experience pages, replace the four-link scan strip with a compact status entry; interrupt only for a relevant actionable problem.

### Applications

Default to active applications, with a small **Needs action** group when something is due. Keep All/stage/due filters available, but avoid making three navigations compete. Do not hide future actions or closed history. Use meaningful CV actions such as **Open CV** / **Build CV**, with revision/state as secondary text; “Ready · V14 · finalised · previous archived” makes the user decode storage history.

Add a visible **Update** action. Ask **“What happened?”**: applied, interview arranged, received outcome, or add next step. Reveal only the relevant date and follow-up fields. Show the resulting stage/date before saving; keep Full details and history for corrections, and retain backwards-transition safeguards. Do not prefill an uncertain historical application date as fact. Formatting gaps between stage labels and counts also need attention.

### Navigation, account and spending

Use Roles, Companies, Applications and Experience as the primary group. Keep Preferences, Learning and Monitoring in a quieter secondary group initially; don't remove destinations until contextual entry points are proven. Learning can be named **Search profile** if the page's synthesis and feedback purpose remains clear. Account and the compact plan/credit readout stay at the bottom; retain mobile access.

The current plan readout is appropriately discreet. Account should open with current plan, available credits and tracked allowance, then **Top up credits**, **Manage plan** and profile/security sections. Reveal the full plan comparison when requested. Hide zero-valued credit-origin breakdowns behind Balance details. Proactive purchase messaging belongs beside the blocked action or nearing-limit state, without a modal interrupting unrelated work. Keep £ prices, recurring/one-off terms, expiry and the actual build charge clear.

## Visual and copy refinements

| Current pattern | Proposed treatment | Preserve |
|---|---|---|
| 2px boxes, header rules, nested panels and hard shadows share emphasis. | Use space and one quiet divider for ordinary grouping. Reserve the strongest border/green fill for selection, primary actions and true alerts. | Visible field boundaries, focus rings and brand identity. |
| Pixel text still appears on small workflow tabs, table labels and badges. | Ordinary readable type for functional text; pixel face for the wordmark and sparse brand moments. Audit actual components, not only the design-system prose. | Distinctive Course of Life character. |
| Long monospaced narrative fields and descriptions dominate writing screens. | Test a proportional reading face for narrative/draft text with a comfortable measure; keep mono for compact metadata if useful. Start with this limited comparison rather than a full rebrand. | User-selected CV document typography; it is separate from app chrome. |
| “Re-score”, “Narrative”, “Type”, “13 motions”, version mechanics. | “Review evidence”, “What you did”, optional “Evidence details”; build duration/technical history only in details. | Diagnostics for support and explicit saved/unsaved state. |
| “Weak” applied to whole jobs; “Ready to build: yes”. | “Add a result to strengthen this example”; “You can build a CV” or the exact missing action. | Honest assessment; no artificial promise of hiring success. |
| Help paragraphs repeatedly explain two competing actions. | Put the consequence in the label: “Save and check · free”; “Rewrite from Experience · 1 credit”. Disclose a fuller comparison once. | Cost, preservation of wording and scope of regeneration. |
| Large delete controls beside every skill/evidence item. | Keep labelled remove actions available in edit mode; expose the text primarily as readable content when viewing. | Keyboard/touch access, undo or restoration. No hover-only deletion. |
| “Page 1 of 1”, zero stage summaries, repeated titles/status. | Remove no-information pagination, de-emphasise zero counts and show identity once per work unit. | Useful counts and clear empty-state explanations. |

Do not simplify by deleting error recovery, factual confirmation, source evidence, active-filter visibility or price information. Put detail where it answers a question, and ensure disclosures have meaningful labels and keyboard focus behaviour.

## Implementation order and acceptance

Effort is relative: **S** is a contained presentation fix; **M** is a journey/component change; **L** includes a new drafting capability and its reliability work. These are scope indicators, not delivery promises.

| Order | Package | Scope / dependencies | Evidence required before completion |
|---|---|---|---|
| **0** | Truthful states and naming | Experience rename delivered here. Finalised/download policy, verification visibility, rule copy and responsive-label/order defects next. **S–M.** | Finalised + missing/old/hash-mismatched assessment fixtures; valid stored-PDF retrieval and safe recovery; unverified import; narrow container at wide viewport. |
| **1** | Reduce everyday visual friction | Compact role filters/cards; group secondary navigation; current-plan summary; remove duplicate CV commands and repeated copy. **M.** | Desktop, 320px/390px layouts and keyboard walkthrough; all original actions still reachable; dirty edits/credit messages retained. |
| **2** | Experience conversation, end to end | Unified job card; shared conversation state; grounded draft action; exact-wording confirmation/version save; manual fallback; resume/retry. **L.** | Plain notes, no metric, ambiguous ownership, conflicting dates, rejected/edited drafts, rapid duplicate submit, stale response, concurrent edit and model failure. No unconfirmed newly drafted experience statement reaches a CV. |
| **3** | Use the conversation across CV work | Quiz confirmation and return to the same review item; prioritised guided review; full table disclosed; clear finalisation/override. Depends on 2. **M.** | Question→accepted evidence→assessment→preview→finalised PDF; dismiss/override keeps truthful scores; unsaved preview differs clearly from saved final. |
| **4** | Application next actions and refinements | Progressive status updates; due-work entry; company evidence disclosures; typography comparison. **M.** | Find due work, record historical application, correct a stage, locate the intended CV, pause/resume monitoring, recover dismissal. |

Use a small moderated task study before declaring the redesign successful: representative first-time and returning users, including phone use. Proposed acceptance is at least four of five participants completing each critical scenario unaided, with **no unnoticed data loss, invented accepted fact or unexpected paid action**. Measure task completion, time to first useful action, backtracking, drafting corrections and ability to explain what was saved. Baselines must be recorded first; these are not measured results or statistically representative estimates.

Technical checks should test behaviour at the boundaries, not mirror JSX: confirmation invalidation after edits, version conflicts, idempotent save, question dismissal, stale review state, finalised download, cost disclosure and mobile focus order. Carry over existing coverage for credit reservation, provenance, skill limits, PDF rendering and CV revision snapshots.

## Source index

Paths below are relative to the repository; line references identify the audited baseline.

| Area | Main evidence |
|---|---|
| Framework and shell | `docs/UX-JOURNEYS.md`; `apps/web/app/(app)/layout.tsx:23`; `components/WorkspaceNav.tsx:6`; `components/ScanStatusBanner.tsx:109`; `app/globals.css`; `docs/DESIGN-SYSTEM.md` |
| Setup and Roles | `apps/web/lib/setup.ts:54`; `app/(app)/page.tsx:66`; `app/(app)/settings/page.tsx:71`; `components/RolesFilterBar.tsx:64`; `components/RolesTable.module.css:5`; `components/RolesTable.tsx:286` |
| Manual roles / Companies | `apps/web/app/(app)/roles/add/page.tsx:10`; `app/actions/role-import.ts:67`; `app/(app)/companies/page.tsx:184`; `app/(app)/companies/[id]/page.tsx:199`; `app/(app)/suggestions/page.tsx:42`; `components/HealthItems.tsx:73` |
| Experience | `apps/web/app/(app)/library/page.tsx:55`; `components/CvLibraryEditor.tsx:313,368,427,465`; `components/RowScoreButton.tsx:74`; `components/EvidenceScore.tsx:49`; `components/LibraryRowTypeMenu.tsx:121`; `lib/cv-library-rows.ts:42`; `lib/cv-library-evidence.ts:175` |
| Evidence contract | `packages/core/src/cv.ts:110`; `packages/core/src/cv-helpers.ts:247`; `packages/core/src/library-import.ts:285`; `apps/web/components/CvGapQuiz.tsx:60`; `app/actions/cv.ts:186` |
| CV review / finalisation | `apps/web/components/CvDraftEditor.tsx:213`; `components/CvAssessmentPanel.tsx:73,121`; `components/CvReviewControls.tsx:51`; `components/CvEvaluationTable.tsx:43`; `lib/cv-next-action.ts:18`; `app/api/cv/[id]/pdf/route.ts:23`; `app/actions/cv.ts:714,874`; `packages/core/src/cv-review.ts:301` |
| Applications / account | `apps/web/app/(app)/applications/page.tsx:110`; `components/ApplicationsTable.tsx:115`; `components/BillingOverview.tsx:86`; `app/(app)/account/page.tsx:61` |

## Verification of the small code change in this review

- Shared sidebar and page heading now say Experience; `/library` and evidence data are preserved.
- Existing `cv-library-editor.test.ts` expectations updated for the accessible label; **23/23 tests passed**.
- `git diff --check` passed.
- The ordinary web typecheck encountered pre-existing duplicate generated `.next/types/* 2.ts` declarations. A temporary configuration excluding those duplicate generated declarations passed; the temporary configuration was removed. The standard command cannot be reported as passing in this checkout.
- The broader redesign is a recommendation and separate interactive design example. It is not implemented or deployed by this review.
