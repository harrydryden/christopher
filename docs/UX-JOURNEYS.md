# Design and UX recommendations: simplifying the six journeys

*Written 19 September 2026 against branch `claude/busy-turing-usy5yd` at the head of PR #70, from
three read-only audits of the code (onboarding and the Library; companies and role review; the CV
workspace, sharing and application tracking). Every friction statement below was read from a file,
and every recommendation names the machinery it should reuse. Where a figure or a claim is inferred
rather than read it is marked **[inferred]**.*

## How to read this

Each journey is framed as a job to be done: what the person is trying to accomplish, what "done"
looks like to them, and what they are anxious about. The recommendations are ranked within each
journey. Effort is **S** (a day, no schema), **M** (a few days, a migration or a new task), **L** (a
new surface or call site). The sequencing at the end groups them into three waves.

The product's own decisions (SPEC §1) are treated as fixed: the keyword gate is the person's hard
filter and the model only ranks within it and proposes; learning is a readable profile, not a black
box; suggestions are verified before they are shown; one shared catalogue, one scan a day; quiet and
reliable beats clever. Several recommendations below are simply the interface catching up with those
decisions.

## What hurts every journey

Six things recur across the audits. Fixing any one of them improves several journeys at once.

1. **Nothing sequences the work.** There is no onboarding, no first-run state that says what to do
   next, and the only prompts are refusals at submit time ("Save your Library first.", the
   unverified-account redirect). An empty account reaches its first CV after roughly eighteen
   interactions across five to seven pages, none of them signposted.
2. **No wait is ever quantified.** Discovery has a five-minute deadline and a scan three, but the page
   says only "Discovery is looking…" or shows an `AutoRefresh` sentence. The one exception is the CV
   build, whose motion-by-motion narrative is the pattern the rest of the product should copy.
3. **The learning surfaces are hidden.** Learning, Health and Suggestions are not in the sidebar;
   they appear in the secondary strip only when you are already in their group. Filter suggestions
   (R-5.6, R-6.9), the seed profile (R-6.3) and Health's attention items are all one page further
   than anyone will go by accident.
4. **The verification wall is discovered at submit time.** `requireVerifiedUser()` is enforced in the
   action, not on the form, so a person can fill the Library and set every filter before learning
   they cannot build or add a company.
5. **Every decision fans out three background jobs** (`synthesize_profile`, `suggest_filters`,
   `tag_reason`), so a thirty-role review session queues thirty tag calls and repeated profile work,
   and the weekly filter-suggestion call becomes a per-decision one.
6. **Model calls are paid before the price is shown.** A CV build's cost first appears in the build
   narrative after the budget has been reserved; the budget refusal is discovered after the redirect.

## Journey 1: Onboarding

**The job.** "Get Christopher watching the right companies for the right roles, with enough about me
that its ranking and its CVs are mine, without a week of setup." Done means: a first scan has run
against filters I chose, and I know what happens next. The anxiety is a blank table that may mean
"nothing matches" or "nothing has happened".

**Today.** Sign up, confirm by email with the password retyped, then five pages with no order:
Companies (paste URLs), Settings (the gate defaults to `["operations"]` in the title, which nobody
chose), Learning (the seed profile, on a page the sidebar does not show), Library (a bare form whose
first save fails schema validation), and a role's Build CV. No document import of any kind exists;
the Library's only import is its own exported JSON.

### Recommendations

| # | What | Why | Reuse | Effort |
|---|---|---|---|---|
| 1.1 | **A setup checklist, derived from data, on the Roles empty state and as a dismissible card until complete**: confirm email → choose keywords and locations → write the seed profile → add three companies → fill the Library. Each step links to the exact field and shows done/not done. | The single biggest gap: nothing sequences the work. Deriving completeness from existing rows costs one query and no new state beyond a `dismissedAt` in `user_settings`. | `needsEmailConfirmation`, `DEFAULT_USER_SETTINGS` vs stored keys, `company_subscriptions` count, `cv_libraries` presence, `seedProfile` | S |
| 1.2 | **Ask for keywords and locations before the first scan, never scan against a default the person did not choose.** The checklist's filter step shows the three gate fields with an example and a plain sentence on what the gate does. | The first scan of a company with no "operations" role produces an empty table with no explanation. The gate is the person's hard filter; it should start as theirs. | `saveKeywords`, `saveLocationFilter`, `evaluateGate`, the Settings cards as they are | S |
| 1.3 | **Move the seed profile onto Settings and into the checklist, as SPEC §3.7 already says**; keep it editable on Learning. | R-6.3 says "at setup you write a few sentences". Today it is entered on a page that is not in the sidebar. | `saveSeedProfile`, the Settings page's `SettingsForm` cards | S |
| 1.4 | **Gate at the form, not the action.** Disable Add companies, Build CV and Add a role for an unverified account with the sentence the banner already uses, and keep the banner. | Discovering the wall at submit time wastes the work done before it. | `needsEmailConfirmation`, the existing banner copy, `buttonClass` disabled state | S |
| 1.5 | **Prepopulate the Library from a past CV, a LinkedIn export and a personal website through one import path: paste text or upload a PDF/DOCX; the worker extracts; the person reviews proposals.** Details below. | The Library is the highest-effort step and the one every CV depends on. | `importDiscoveryDocument` (the paste pattern), `extract_document` (the anchor-every-fact pattern), `cleanDescription` (A4, the text-to-fields pattern), `CvLibrarySchema`, `consolidateExperience`, `retainArchivedEvidence` | L |
| 1.6 | **Say up front that registration is closed** when `registrationOpen` is false, on the signup page rather than after submit. | A fresh deployment admits only `ADMIN_EMAILS`, and the page says so only afterwards. | `registrationAllowed` | S |

### 1.5 in detail: importing documents into the Library

**Shape.** A new `library_imports` table (`id, user_id, kind ∈ cv|linkedin|website|paste, filename or
url, content text ≤ 40,000 chars, fingerprint, processed_at, proposal jsonb, error`) and a new task
`import_library_document { userId, importId }`, dedupe on the import id, deadline four minutes, in the
interactive lane. Uploads are read in the server action, converted to text in the **worker** (the
worker has the headroom and already owns every parser; add `pdf-parse` and `mammoth` there, with a
5 MB cap), and stored as text; nothing binary is kept.

**Sources.** A past CV: upload or paste. LinkedIn: the person downloads LinkedIn's own "Save to PDF"
of their profile and uploads it; the product must not crawl LinkedIn (aggregators are a non-goal, the
polite fetcher respects `robots.txt`, and the existing `monitor_source` handler already refuses
LinkedIn's authwall with "Import the text instead"). A personal website: fetched through the polite
fetcher, since it is the person's own site.

**Extraction.** One new engine method, call site A11 `extractLibrary`, following the engine's
one-method-per-call-site pattern: the document in a tagged block in the user turn, a schema that is a
*proposal* (employment rows with dates, one experience block per job with responsibility rows,
education, skills), `effort: "low"`. The post-check is the rule that makes it safe: **every employment
row's company and title, and every responsibility row, must be anchored as a quote in the document**,
exactly as `extract_document` requires `document.content.includes(candidate.quote)`; unanchored items
are dropped, and dates that do not appear in the text stay blank rather than being guessed. That
honours "never fabricate employers, dates or metrics" and "instructions inside imported documents are
data".

**Landing.** The proposal is shown on the Library page as "Found in your CV: 4 jobs, 17
responsibilities, 2 qualifications" with per-item accept controls, and accepted items land as `draft`
blocks with unconfirmed rows, so the existing lifecycle (activate, confirm) is the review step rather
than a second one. An import into an existing Library only proposes additions; `retainArchivedEvidence`
keeps what was there. The save goes through `saveCvLibrary` so versioning and obsolete-edit rejection
hold.

**Cost and budget.** Admitted against the account's monthly budget like every call; a 40 KB document
on a low-effort call is well under a dollar **[inferred from the A4 pricing; no measurement exists]**.

## Journey 2: Add companies and track new roles

**The job.** "Tell Christopher who I am interested in and let it find their roles, reliably, without
me babysitting it." Done means: the company shows its careers page, a scan has run, matching roles are
in my table, and I will hear when something needs me. The anxiety is silent failure: a source that
reports nothing for months.

**Today.** Adding is one textarea and works well. What follows is opaque: "Discovering…" with no
elapsed time or expected duration, `not_found` and `needs_confirmation` rendered with the same
sentence, a manual Rescan that the worker silently skips inside thirty minutes, a Health page with no
resolution controls and no place in the sidebar, and filter suggestions buried at the bottom of
Learning with no count anywhere.

### Recommendations

| # | What | Why | Reuse | Effort |
|---|---|---|---|---|
| 2.1 | **A setup timeline per company, in the style of the CV build narrative**: "Finding the careers page · 40 s", "Found a Greenhouse board (98%) · scanning", "Scanned 2,331 postings · 4 match your filters · scoring". Elapsed time from the task and run rows; an expected duration sentence per step ("usually under a minute"). | No wait is quantified anywhere; the CV narrative proves the pattern works and the rows to drive it (`tasks`, `discovery_runs`, `scans`) already exist. | `discovery_runs`, `scans`, `tasks.startedAt`, `deadlineFor`, `AutoRefresh`, `narrateStep` as the model | M |
| 2.2 | **Distinguish "found nothing" from "found candidates" in the setup card**, offer Re-discover inside it, and keep a competing candidate visible after a source works (today it is administrator-only). | Two different situations read identically, and the recovery action is above the card rather than in it. | `companyDiscoveryState`, `getLatestDiscoveryRun`, `rediscoverCompany`, `useDiscoveryCandidate` | S |
| 2.3 | **Tell the person when a Rescan was skipped and when the next scan is due** ("Scanned 12 minutes ago; the next scan runs at 06:00 Europe/London"). | The worker returns `skipped: "scanned recently"` and the interface hides it. | `getCompanyScans`, `scanTime`/`timezone`, the scan handler's result | S |
| 2.4 | **Give Health its one-click resolutions (R-9.2)**: confirm a candidate, paste a URL, pause, re-discover, dismiss, all inline, and add the missing items (budget exceeded, re-discovery proposals, three consecutive failures named as such). Put Health in the sidebar under Settings with a count. | The SPEC promises it and the actions all exist; today every row is a link. | `useDiscoveryCandidate`, `pasteDiscoveryUrl`, `pauseCompany`, `rediscoverCompany`, `listSourcesNeedingAttention`, `accountAiSpend` | M |
| 2.5 | **Surface suggestions where the person already is**: a one-line strip on Roles ("3 suggestions from your scans: Lead, Head of, partnership*") with accept/dismiss inline, a count on the Companies entry for company suggestions, and after accepting a filter term, "admitted 9 roles" using the count `reevaluateGate` already returns. | Both suggestion kinds land in the last card of a hidden page; acceptance gives no feedback. | `listPendingFilterSuggestionsResolved`, `acceptFilterSuggestion`, `reevaluateGate` return value, `suggestionCount` | S |
| 2.6 | **Debounce the per-decision fan-out**: enqueue `suggest_filters` weekly and after every fifth decision, `synthesize_profile` at the thresholds the handler already enforces, and let `rejected` filter suggestions expire after sixty days as R-6.9 says. | Cost and noise, and a stale rejection is permanent in practice. | `dedupeKeyFor`, the handlers' own thresholds, `filter_suggestions.resolvedAt` | S |
| 2.7 | **Name the missing-score states**: "scoring", "not scored: budget spent", "closed", instead of one em dash. Persist the skip reason the score handler already computes. | A blank score covers five causes; the person cannot tell waiting from refused. | `handleScoreJob` skip reasons, a `score_state` column on `user_jobs`, `FitBar` | M |
| 2.8 | **Companies list: add open-role and shortlisted counts and the source type; collapse Pause, Archive and Stop following into one control with plain words** ("Pause scanning", "Hide from my list", "Stop following"). | `shortlistedRoles` is computed and never rendered; three similar controls differ only in confirm text. | `listCompanies` fields, `Badge`, `ConfirmSubmitButton` | S |
| 2.9 | **Show the company profile (A9) to followers**, since it drives the suggestions they are asked to judge. | It is administrator-only on the page today. | `getCompanyProfile` | S |

Not recommended: a per-account scan time. The catalogue is scanned once for everyone; showing the
next scan time (2.3) answers the real question.

## Journey 3: Review roles and decide

**The job.** "Get through today's new roles fast and make a sound apply-or-pass call on each, with
Christopher learning from what I say." Done means: the Matched tab is empty, every pass has a reason,
and the shortlist is real. The anxiety is deciding blind or losing a role by mistake.

**Today.** The review panel shows title, meta line, fit rationale and links. **It does not show the
stored description** (`fetchRolePage` deliberately leaves it in the database and `fetchRoleDetails`
has no callers), nor the matched keywords, the fit verdict, or why the location passed. A decision
therefore rests on title, location and a score, or on opening the vacancy in a new tab. Shortlisting
takes one keystroke; dismissing takes four or five interactions. Undo means finding the role again in
another tab.

### Recommendations

| # | What | Why | Reuse | Effort |
|---|---|---|---|---|
| 3.1 | **Show the evidence the decision needs, in the panel**: the stored description (loaded on expand, one round trip), matched keyword chips (R-5.5), the fit verdict beside the score, the rationale on hover of the score, the salary line, and "why here" (the location term that matched, or "remote"). | Decisions are made blind today; every field is already stored per account. | `fetchRoleDetails`, `keywordTerms`, `fitVerdict`, `locationOk`, `salaryText`, `FitBar title` | S |
| 3.2 | **An undo toast after every decision** ("Shortlisted VP Operations at Hims · Undo", five seconds) instead of hunting the role in another tab. | The optimistic row removal makes a role vanish with no confirmation of where it went. | `decide(jobId, null, "")`, `removedIds` in `RolesTable` | S |
| 3.3 | **Keyboard that teaches itself**: highlight the first row on load, show the five shortcuts inline under the table, `enter` saves, `a` opens a one-line optional reason ("one line on why helps the ranking", R-6.1) that `enter` skips. | Keyboard navigation is invisible until discovered, and the first `a` does nothing. | `highlightIndex`, the reason box, `SKIP_REASON_REQUIRED` | S |
| 3.4 | **Find what I decided**: a decided-at sort key and a "This week" filter on Shortlisted and Dismissed. | The decision date is built into the view model and never rendered; there is no way to find last week's calls. | `decisions.createdAt`, `SORT_KEYS`, `parseRolesFilters` | S |
| 3.5 | **After Apply, offer the build in place**: "Build a CV for this role · about $3" in the panel, one click, with the stored description and the pre-flight budget check of 4.1. | Today the only guidance after Apply is a link to another page. | `requestCv`, `estimateCvBuildUsd`, `accountAiSpend` | S once 4.1 exists |
| 3.6 | **Sort by column headers and surface availability as chips** above the table, leaving the rarely used filters collapsed. | R-7.1 asks for sorting on every column; today it is a select inside a `<details>`. | `SORT_KEYS`, `DEFAULT_SORT_DIR`, `TH` | S |
| 3.7 | **A stage legend on Roles** and the stage badge in the collapsed row, not only in the panel. | A stage badge with no explanation in place. | `ROLE_STAGE_DESCRIPTIONS`, `stageTone` | S |
| 3.8 | **One query path for the table and the CSV**, so the file cannot disagree with the screen, and a note when the 20,000-row cap applies. | Two code paths filter and sort differently. | `fetchRolePage` | S |

Not recommended: bulk dismiss with one shared reason for up to a hundred roles as the *primary* path.
It writes a hundred identical snapshots into the learning corpus. Keep it, but make a per-row quick
reason the default and cap the shared-reason path lower.

## Journey 4: Make the best application

**The job.** "Turn a shortlisted role into the strongest honest CV I can, understand what the
reviewer thinks is weak, fix it, and get a second opinion from someone I trust." Done means: a
finalised PDF I believe in. The anxiety is cost, waiting, and claims I cannot back.

**Today.** Six interactions from Build CV to a downloaded finalised PDF, which is good. The waits are
narrated better than anywhere else in the product. The friction is around the edges: the build lives
two clicks away from the row that asked for it; the budget refusal arrives after the redirect; the
two editing actions differ only by label; evidence gaps have no link to the Library entry that would
close them; the Applications table's CV cell does not refresh; `Remember wording` sits two tabs from
the words it remembers; and there is no way to show the CV to anyone else.

### Recommendations

| # | What | Why | Reuse | Effort |
|---|---|---|---|---|
| 4.1 | **Price and admit before the button is pressed**: the Build CV control says "about $3.10 of your $18.40 left", and `requestCv` refuses with the budget sentence *before* creating a draft when the estimate does not fit. | Today the refusal is discovered on the CV page after the redirect. | `estimateCvBuildUsd`, `accountAiSpend`, `aiBudgetRefusalMessage` (the worker's admission stays as the authority) | S |
| 4.2 | **Explain the two actions where they are chosen**: "Save Direct Edits · keeps your wording, re-checks it · about $2" and "Rebuild from Library · rewrites from the latest Library · about $3". | The only stated difference is the label. | `estimateCvBuildUsd(…, "assessment" \| "all")` | S |
| 4.3 | **Close the loop from an evidence gap to the Library**: each gap row links to "Add evidence for this" on the Library, opening the right job with the requirement quoted as a prompt; after the Library is saved, "Rebuild from Library" is offered from the same row. | Gaps name what is missing and offer no way to supply it. | `cvEvaluationRows` gap rows, the Library editor's per-job fieldsets, the evidence review of Journey 5 | M |
| 4.4 | **Refresh the Applications CV cell while a build runs**, with the same poll the CV page uses. | It is the one CV status that does not update itself. | `AutoRefresh`, `/api/work-status?cv=` | S |
| 4.5 | **Say why Finalise is unavailable** with the three sentences `assertCvFinalisable` already produces, instead of hiding the button. | The messages exist and are unreachable. | `assertCvFinalisable` | S |
| 4.6 | **Move `Remember wording corrections` beside the Content editor**, and show the build's cost line in the workspace header rather than only in the collapsed log. | Two tabs from the text it remembers; the price paid is hidden. | `cvBuildTotalsLine` | S |
| 4.7 | **A share link for a preview CV, with comments** (below). | The second opinion is the request; nothing share-shaped exists. | `auth_tokens` pattern, `cvSectionBlockId` anchors, the evaluation table's per-row structure | L |

### 4.7 in detail: sharing a preview for comments

**The rule it touches.** SPEC §2 lists "sharing one account's data with another, teams, or public
access" as a non-goal. A scoped link is narrower than that sentence forbids: one revision of one
document, read-only, revocable, expiring, with no session and no reach into the account. It still
needs the non-goal amended, not only code. **Confidence that this is the right call: medium** — the
value is real, and so is the cost of a public route in a product whose every other read is scoped by
`userId`.

**Data.** `cv_shares (id, user_id, draft_id, token_hash unique, allow_comments, expires_at,
revoked_at, created_at, view_count)`, modelled on `auth_tokens` (only the hash is stored) but
multi-use until revoked or expired, and `cv_share_comments (id, share_id, user_id — the owner, anchor,
author_name ≤ 80, body ≤ 2,000, created_at, resolved_at)`. Anchors are the IDs the assessment already
cites: `CV_PROFILE_ID` and `cvSectionBlockId(entryId)`, so a commenter's note and a reviewer's finding
sit beside the same text.

**Route.** `/share/[token]`, added to the middleware's negative-lookahead so it is not redirected to
login, authenticating itself by token lookup and deriving the owner from the share row (which is how
the "never read a CV without a `userId`" rule is honoured). It renders the HTML content with
`cvDisplaySections`, projected to `content` only: never `jobDescription`, `librarySnapshot` or
`assessment`, which live on the same row. `cache-control: private, no-store`, a per-token and per-IP
rate limit using the `login_attempts` key pattern, a fourteen-day default expiry, and Revoke from the
workspace.

**Owner's view.** Comments appear in the Evaluation tab as a new change type, "Comment", one row per
anchor with the count, and in the Content tab as a count beside the block; resolving a comment is the
owner's action. Nothing a commenter writes reaches a model call unless the owner pastes it, so the
"data, not authority" rule is untouched.

## Journey 5: Building and improving the Library

**The job.** "Keep one honest, well-evidenced record of what I have done, so every CV can be shaped
from it and no reviewer can call a claim unsupported." Done means: each job in my history is
described with what I was responsible for, what I solved, what came of it, with numbers, and how I
work, and the product tells me where it is thin. The anxiety is writing a lot and still being told
the evidence is weak at CV time.

**Today.** One 134-line client component, three tabs, six-plus interactions to add one experience
entry, new blocks born `draft` with unconfirmed rows (so a correctly filled Library still fails at
Generate), no unsaved-changes guard, all-or-nothing save, error messages keyed by array index, no
version history or writing preferences on the page (SPEC line 744 asks for both), and a horizontal
scroll on a phone. Evidence quality is judged only at CV time, per CV, at about $2 a run.

### Recommendations

| # | What | Why | Reuse | Effort |
|---|---|---|---|---|
| 5.1 | **Structure each experience entry into six facets** — Responsibilities, Problems solved, Outcomes, Metrics, Milestones, Working style — as a tag on each row, keeping rows as the unit the writer, the confirmation and the assessor already use. | This is what makes an entry evaluable, and it tells the person what to write without a blank box. | `responsibilityRows`, `confirmedResponsibilities` (keyed by exact row text: the facet map follows the same precedent), `structuredExperience` as the upgrade-flag pattern | M |
| 5.2 | **An Evidence score per entry, from the CV assessment's own method**: a review call classifies rows and quotes them; code computes the score; the page shows None / Weak / Good / Strong with the three-cell bar the evaluation table uses, and the prompts that would raise it. Details below. | Evidence quality should be known when it is written, not discovered per CV at $2 a time. | `assessCv`'s batching, caching and anchoring rules; `validateCvReview`'s `cvQuoteIsAnchored`; the `Evidence`/`Experience` rating cells | L |
| 5.3 | **Evaluate in the background after every save**, only for entries whose rows changed, and show "Evaluating…" until the scores land. Details below. | The person keeps writing; the score arrives. | `saveCvLibrary` → a new task, `rescore_all` as the dedupe precedent, `scoreInputHash` as the change-detection precedent, `AutoRefresh` | M |
| 5.4 | **Make the Library safe to edit**: an unsaved-changes guard, a sticky Save bar with "Unsaved changes", server errors mapped to the job or entry they concern (not "Job 3"), and the obsolete-edit rejection offering "reload and keep my text". | Everything typed can be lost by one click on the sidebar. | `SettingsForm` pending state, `revealInvalidField`, `CompanyNotepad`'s saved/unsaved indicator as the pattern | S |
| 5.5 | **Make "ready for a CV" visible on the Library**: a line per job ("3 of 5 rows confirmed · draft") and one at the top ("Ready to build: no — activate Acme and confirm its rows"), with Confirm all per job. | A library of drafts fails at Generate rather than at Save. | `groupCvLibrary`'s refusal, `eligibleCvEvidence` | S |
| 5.6 | **Put version history and writing preferences on the Library page** as SPEC line 744 asks, with the version number shown and a diff between two versions. | They are on Settings today and the version is a hidden input. | `cv_libraries.version`, `resolveCvWritingPreferences`, the profile page's version select as the pattern | M |
| 5.7 | **A phone layout for the employment table** (stacked cards under `md`), and a per-job "Add responsibility" that focuses the new row. | `min-w-[720px]` forces a scroll; six interactions per entry. | `table.tsx`, `EmploymentHistoryTable` | S |

### 5.2 and 5.3 in detail: the Evidence score

**What is scored.** Each experience entry, against the six facets, on the same three ideas the CV
assessment uses: coverage (is each facet present), specificity (is the row concrete or generic), and
support (is there a number, a scope or a named outcome). Education and skill blocks get a lighter
two-facet version (what, and evidence of level).

**The call.** One engine method, call site A12 `reviewLibraryEntries`, batched like `assessCv`: the
whole Library as a cached block, then up to eight entries per batch, `effort: "low"`. The output
schema per row: the facet it serves (or "unclear"), `specific: boolean`, `quantified: boolean`,
`outcomeLinked: boolean`, and a `quote` that must be anchored in the row (`cvQuoteIsAnchored`,
NFKC and whitespace-normalised, exactly as review quotes are checked); per entry: up to three
`prompts`, each a question the person can answer in one line ("What changed as a result, and by how
much?"). Rows the model cannot quote are marked unverified and count as generic, never dropped or
rewritten; the model classifies and asks, it never writes evidence. Demographic content is refused as
the rubric validator refuses it.

**The score.** Computed in `packages/core` from the classifications, never taken from the model:
facet coverage weighted (Responsibilities 1, Problems 1, Outcomes 2, Metrics 2, Milestones 1, Working
style 1), plus a quality term from the share of rows that are specific and the share that are
quantified, on a 0–100 scale that maps to None (< 25), Weak (< 50), Good (< 75), Strong. The same
weights are the ones a CV reviewer rewards, so a Strong entry is one the CV assessment will find
evidence in.

**Storage and display.** `cv_library_reviews (user_id, library_version, entry_id, input_hash,
review jsonb, score, created_at)`, read behind the interface-ahead-of-worker guard. The Library shows
the badge and bar per job, the prompts beneath the rows, and a Library-wide line ("Evidence: Good ·
2 jobs are Weak"). Because rows are the unit and `input_hash` is per entry, a typo fix re-evaluates
one entry, and an unchanged entry carries its last review across versions.

**The task.** `saveCvLibrary` enqueues `review_library { userId, libraryVersion }` (dedupe on the
account, so a burst of saves runs once for the newest version), interactive lane, four-minute
deadline, admitted against the account's monthly budget with the refusal sentence the rest of the
product uses, recorded in `ai_calls` under its call site, and shown on Operations with the other
motions. Cost per full pass on a 45 KB Library on Fable 5.1: under a dollar with the cached prefix,
and cents for a single changed entry **[inferred from `estimateCvBuildUsd`'s assessment share; no
measurement exists]**.

**What it must not do.** Gate anything. An entry with a Weak score is still active evidence if the
person says so; the score informs, the person decides, exactly as the fit score never removes a role.

## Journey 6: Tracking applications

**The job.** "Know where every application stands, what I owe next, and what happened, without a
spreadsheet." Done means: one table I trust, that agrees with the roles page. The anxiety is losing
track of an interview or discovering two pages disagree.

**Today (after PR #70).** One table, eight stages with a legend, a status control that creates or
updates the single application row per role, the CV in the row, and two rules that keep the pages
agreeing (Withdrawn records a skip; a skip withdraws a live application). Still missing: a date per
stage (only `applied_on` exists; an interview date cannot be recorded as a date), a next action,
outcomes reaching the preference profile (the synthesiser reads only decisions), a guard on backwards
transitions, and a per-company view.

### Recommendations

| # | What | Why | Reuse | Effort |
|---|---|---|---|---|
| 6.1 | **A date on each stage entry and a "next step" line**: the history entry gains an optional `on` date and the row a `nextAction` text with an optional date; rows past their date read "Interview was Tuesday: record the outcome". | Interview dates are the thing people actually track; history has only the save time. | `applications.history` entries, `setRoleStage` | M |
| 6.2 | **Feed outcomes to the preference profile**: accepted and rejected as strong signals in `synthesize_profile`'s inputs, distinct from decisions. | Outcomes teach the ranking nothing today. | `handleSynthesizeProfile` inputs, `latestApplicationFor` | S |
| 6.3 | **Confirm backwards transitions** ("Move this application from Accepted back to Applying?") and never rewrite an outcome silently; skip the history entry when nothing changed. | The control allows any transition; re-saving notes inflates history. | `roleStageRank`, `beyondApplied` | S |
| 6.4 | **A stale hint instead of reminders**: Applied or In process rows untouched for fourteen days read "No update for two weeks". Notifications stay a non-goal. | Cheap, derived, and answers "what do I owe" without email. | `updatedAt` from `listPipeline` | S |
| 6.5 | **A per-company link from the company page** ("2 applications") into `/applications?company=`, and the Applications page filtering by company. | The company page has no view of its applications. | `listPipeline` filter, `companyIcon` | S |
| 6.6 | **Page the pipeline in SQL**, and give the roles table's Shortlisted count a stage breakdown ("Shortlisted 12 · 3 applied") rather than moving the tabs onto stages. | `listPipeline` reads every row and pages in JS; tabs are decisions and should stay so. | `roleStageSql`, `fetchRoleCounts` | S |

## Sequencing

**Wave 1: coherence, no schema (about two weeks).** 3.1, 3.2, 3.3, 3.4, 3.7, 3.8 (review the role with
its evidence); 1.4, 1.6 (the verification wall); 2.2, 2.3, 2.5, 2.6, 2.8, 2.9 (companies and
suggestions); 4.1, 4.2, 4.4, 4.5, 4.6 (the CV edges); 5.4, 5.5, 5.7 (the Library made safe); 6.3, 6.4,
6.5, 6.6. Each is a day or less and most remove a friction the audits found in a single file.

**Wave 2: the model of the person (migrations and one new call site).** 1.1, 1.2, 1.3 (the
checklist and filters-first); 2.1, 2.4, 2.7 (waits and Health); 5.1, 5.2, 5.3, 5.6 (facets, the
Evidence score, history); 6.1, 6.2 (stage dates, outcomes to the profile); 3.5 and 4.3 once 4.1 and
5.2 exist.

**Wave 3: new surfaces (a spec amendment and two new call sites).** 1.5 (document import into the
Library) and 4.7 (the share link with comments).

## What I would not do

- Crawl LinkedIn, or any aggregator, for a profile. The person's own export, pasted or uploaded, is
  the honest path and the only one the fetcher's rules allow.
- Let a score of any kind gate what is shown, stored or built. The fit score ranks, the Evidence
  score informs, the gate is the person's.
- Move the roles tabs onto lifecycle stages. Tabs are the person's decisions; the stage is the
  application's progress; the badge and the Applications page are where the stage lives.
- Add notifications before the in-product hints (2.5, 6.4) have shown what people actually miss.

## The weakest part of this plan

The Library redesign (5.1 to 5.3) touches the writer, the assessor and every stored library at once,
and its cost figures are inferred. It should start with the facet tagging and the deterministic score
over the person's own tagging, measured against a handful of real libraries, before the review call is
added; if the deterministic half already tells people what to add, the call may be worth less than
its cost.
