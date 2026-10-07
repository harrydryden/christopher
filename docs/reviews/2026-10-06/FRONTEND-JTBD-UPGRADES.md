# Course of Life — JTBD frontend upgrades

Implementation of the [6 October design review](FRONTEND-JTBD-DESIGN-REVIEW.md), based on main `b5d6acb`. Astra directed design and integration; Sol agents implemented and independently reviewed the journeys.

The change reduces competing controls while retaining direct editing, evidence provenance, explicit confirmation, revision history, recovery and visible credit costs. This is an implementation record, not a new measured usability score.

## Delivered journeys

| Job | Implemented change | Behaviour preserved |
|---|---|---|
| J1: Get useful roles | Two starting intents: monitor companies or add an existing role by link/PDF. Verification appears before manual import. Setup copy describes the actual selected match fields. | Existing setup progress, saved preferences, verification/resend and entered work after a refused submission. |
| J2: Monitor companies | Useful role counts and monitoring state lead the list. Source/provider details, exact check times and suggestion quotes are disclosed on demand. Monitoring becomes a compact disclosure while writing. | Actionable exceptions remain visible; follow management and source diagnostics remain reachable. |
| J3: Choose roles | Compact filters with active count, visible selections and conditional Clear; availability remains accessible. Narrow cards put role identity before actions using consistent container breakpoints. | Desktop table, selection, shortlist/dismiss, undo and keyboard shortcuts. |
| J4: Produce an accurate CV | Write / Review / Appearance; clearer preview and save states; fewer duplicate commands. Ordered findings with Previous/Next, progress, dismissal and explicit finalisation override. Full assessment is secondary. The evidence conversation is shared with the quiz and linked from review. | Exact direct edits, confirmed evidence only, job-description reference, rewrite cost, truthful scores, all review and revision controls. |
| J5: Maintain reusable experience | Experience naming; Work history / Education & skills / About you. One job card combines details and evidence. The selected job is remembered; metadata, scoring and bulk editing are disclosed. Questions lead to rough answers, editable proposals and explicit confirmation. | Imports, active/archived jobs, restoration, skill controls, version conflicts, direct editing and writing preferences. A first job can be saved before adding evidence; CV generation still requires confirmed evidence. |
| J6: Manage applications | Active applications and due work first; visible Update and Open CV actions. “What happened?” reveals relevant fields, with full details/history available. | Existing dates and notes survive focused updates, historical dates are not guessed, backwards changes retain safeguards, and abandoning dirty work requires a decision. |
| Spending and orientation | Four primary navigation items; quieter workspace tools. Account begins with the current plan, available credits and allowance, then top-ups and plan comparison. Native links open the corresponding disclosure. | Existing plan prices, renewal/credit explanations, account controls and mobile access. |

Shared cards, dividers, headings, badges and table labels use quieter visual weight and readable functional type. Narrative evidence and job descriptions use proportional text. The CV document's theme and layout remain controlled by its existing renderer.

## Evidence conversation contract

1. A question identifies the saved job or evidence destination. The user supplies plain notes without needing a metric.
2. A queued A13 worker proposes one evidence row using the answer and server-read job context. Pending proposals live separately from canonical Experience.
3. The user sees their answer and the proposed wording, can edit either, reject it or use their answer directly. No model response is auto-confirmed.
4. The affirmative save writes the exact reviewed wording through the existing versioned Experience writer. The quiz retains its final confirmation/continuation boundary.
5. Draft/answer state survives navigation within the tab; pending server proposals can resume. Skips record a decision without changing evidence quality or CV scores.

Ownership, destination and base-version checks run on the server. Fingerprints make repeat requests and confirmations idempotent; worker attempt and lease fences prevent a late response from replacing a resolved draft. Client polling cannot replace wording the user has already edited. Failure, unavailable models and exhausted internal budgets keep the manual route available. Drafting uses the existing internal AI budget; it does not spend a CV credit.

Grounding checks reject unanchored supporting quotes, new numeric claims and several ownership/approximation escalations. These are conservative checks, not a semantic proof of truth; the explicit review-and-confirm boundary remains necessary.

## Finalised CV lifecycle

Finalisation now stores the rendered PDF and the finalised state in one transaction. Subsequent preview, download and application attachment use those stored bytes rather than today's renderer or assessment rules. Editing requires a new revision. A missing stored PDF gives an explicit recovery path instead of promising a download that cannot succeed.

Historical limitation: before this change, an older download could overwrite its cached PDF. The application preserves the bytes available for those historical revisions; it cannot prove they are identical to the original finalisation. Newly finalised revisions have the stronger immutable-artifact contract.

## Rollout and validation

Apply additive database migration `0060_evidence_drafts.sql` before enabling drafting, and deploy both web and worker so the new `draft_evidence` task is handled. An older database can still render Experience; draft actions require the migration. Evidence drafts are user-owned and cascade with account deletion.

The A13 report in `docs/evaluations/evidence-drafting-2026-10-06/report.json` records synthetic contract tests, zero provider cost and an **unverified** model-quality status. It does not relabel the existing CV replay or satisfy a strict live-model release qualification.

### Verification completed — 7 October 2026

The final browser smoke passed against a fresh local production build and a disposable account. It covered:

- CV tabs, skill editing, preview, saved edits, responsive layout, quiz continuation, persistent dismissal, explicit finalisation override, PDF download, unsaved-edit protection and sharing.
- Tailoring against the confirmed Experience version, immutable snapshots, skip/resume and responsive evidence tags.
- Application status updates and mobile forms, including preservation of existing dates and notes.
- Experience question → answer → editable wording → explicit confirmation: the exact reviewed wording created version 2, the next question advanced, and skip/reload retained the answer without changing canonical evidence. The manual route made no provider calls, queued no AI task and spent no CV credit.
- Account top-up and comparison links opening the correct disclosures; Roles filters, mobile navigation, keyboard dismissal/focus and layouts at 320px and 390px.

Visual inspection identified and resolved two narrow-screen defects: shared select padding overlapped the dropdown arrow, and the Shortlisted tab wrapped within its label. A focused browser rerun confirmed 32px arrow clearance for both sorting controls and no page overflow at both phone widths. Screenshots of Experience, Account, Roles, CV review and Applications were inspected.

The fresh production build, web typecheck, route JavaScript budgets, ten targeted UI regression tests and whitespace checks passed. The earlier integrated verification recorded 3,401 passing application tests, plus 126 passing release/performance script tests; those broader suites were not repeated for the final CSS and browser-harness adjustments.

This verifies local implementation and browser behaviour. Live paid-provider quality, Stripe checkout and moderated usability research remain unverified; the review's proposed four-of-five participant target has not been measured.

### Release follow-up — 7 October 2026

The implementation was committed and pushed to PR #107. Hosted browser journeys, Lighthouse, shuffled-order worker tests, the worker image and Vercel preview passed on the first implementation commit. Hosted CI exposed two additional issues: Linux bundle sizes narrowly exceeded the Experience and Add a role budgets, and the conflict-recovery test relied on a fixed 20ms delay for a lazy import. The follow-up defers the sampled performance observer while preserving once-per-load sampling, and waits for observable conflict-recovery results. All 32 focused tests pass; a fresh build, typecheck and unchanged bundle budgets also pass locally.

Production merge is held: the strict release qualification requires a verified, published, passing live CV replay at prompt set `11ae22aed3fe`. The current reports are explicitly unverified, and the local evaluation environment lacks provider credentials. No production merge or deployment is claimed.
