# ADR 0001: A CV presents targeted evidence for an application

Status: Accepted — implementation and local verification completed; hosted CI and deployment remain separate gates.

Date: 30 October 2026

## Context

Experience is the person's reusable evidence repository. A CV is a selective, attributed argument for a particular role. Treating every confirmed item as compulsory CV content encourages long documents, repeated achievements and weak first-page emphasis. Selection must not delete evidence, invent claims or hide whether an essential requirement is demonstrated.

The current system already has immutable library snapshots and CV revisions, exact evidence references, a fixed requirements rubric, evidence planning, measured A4 rendering, roughly ten suggested skills across up to five categories, immediate manual Save and a separate paid Check. It also has some editorial heuristics. These are retained. The important changes are application-specific selection and priorities, better writing and presentation guidance, and a useful review that keeps factual assurance separate from editorial judgement.

Current generation and fitting preserve every active confirmed role and qualification. This decision deliberately replaces that blanket policy for new, explicitly targeted CVs. Legacy drafts keep their existing behaviour unless the person adopts a targeting brief.

## Decision

### 1. Store a versioned targeting brief with each CV revision

A draft-owned brief records entry treatments, confirmed role priorities, presentation choices and the source identities against which those choices were made. It is copied into new revisions and validated by one shared core contract. It is not a library preference or mutable global setting.

- Entry choices use existing stable entry IDs: **Feature**, **Summarise** or **Omit**. Feature allocates normal, relevant detail; Summarise retains the real role/employer/dates or qualification heading and at most one concise sourced bullet; Omit removes it from printed content. Manual full wording is retained separately so returning to Feature restores it rather than losing edits. Optional supporting sections use the same selection principle.
- Summarise applies to Experience and Interests. Education, Training and structured skill categories offer Feature/Omit; skill categories retain their individual-skill selection controls. Freeform legacy qualification blocks may contain several distinct qualifications, so forcing them into one bullet would contradict the requirement to keep each qualification separate. Individual qualification entry selection and manual editing remain available, without guessing how many qualifications a block contains. UI and server enforce the same source-kind choices.
- The complete source snapshot remains available for factual review and interview preparation. Filtering never renumbers source rows or rewrites source IDs. A derived eligible-writing view carries the original identifiers.
- Omitted entries cannot supply newly generated summary claims, bullets or skill recommendations for this CV. The writer, fitter and optional improver all honour the same brief. Existing wording sourced only from an omitted entry is surfaced for removal or deliberate revision, rather than silently relabelled as current.
- Omission is explicit. Removing an essential requirement's sole demonstrated evidence produces a visible coverage warning and acknowledgement; it never changes that requirement's importance, removes it from the rubric or silently reinstates the omitted entry. Dates and employers are never fabricated to fill a resulting chronology gap.
- Choices belong to the CV/application. Saving them does not archive, edit or remove Experience entries, and does not alter another application's CV.

### 2. Confirm emphasis before new wording is written

After the existing role-requirements extraction and full-evidence mapping, a new targeted build offers the person three to five emphasis priorities from the fixed rubric. Fewer are valid when fewer usable priorities exist. Recommended picks are preselected, but confirmation is explicit. Every essential requirement remains visible and remains in assessment, including when there are more than five essentials. The existing mapping stage runs once or reuses its valid result; it identifies which essential evidence would actually be lost, rather than warning about every essential whenever an unrelated entry is omitted.

This is a durable, resumable preparation state after full-evidence planning and before writing. Waiting for the person releases the worker slot and short-lived spending admission; it does not repeatedly enqueue work. Confirmation is account-owned, idempotent and fenced to the exact role description and server-derived rubric/model/prompt identity. Reusing a request key with different choices is rejected. Changed role text requires new confirmation. Existing ready CVs can adopt a brief using their current rubric and validated mapping; ordinary legacy edits are not forced through a new build. Confirmation and later targeting edits share the same omission-warning and acknowledgement validation.

The preparation pause belongs to the same build and consumes at most one CV credit. Duplicate confirmation cannot charge or reserve again. Abandonment and resume use the existing reservation/refund and task-lease rules; a pause is not a second paid build.

User-selected emphasis changes ordering and writing allocation, not factual support thresholds or the denominator used to report all essential requirements. An emphasis-only change can reuse unchanged role extraction and factual evidence mapping; it invalidates downstream writing/editorial results that depend on emphasis.

### 3. Recommend one or two pages, preserve explicit choices

For new targeted builds, recommend two pages and offer one page for a concise application. Explain the trade-off in useful detail rather than imposing a universal one-page rule. The existing one-to-five-page override remains available. Existing stored themes, finalised documents and explicit Settings choices are preserved; changing the new-build recommendation must not reinterpret legacy missing-theme values.

New targeted documents use a versioned template with a 12-point body by default and an explicit 11-point option. Existing legacy output retains its 10-point body and explicit old themes. Font size is never reduced automatically to meet a page target. Measure the real PDF: a page target is not permission to clip content or invent shorter facts. If selected evidence cannot fit, show actual pages and offer summarising/omitting selected material or changing the limit. The fitter must respect the brief and preserve the essential evidence that remains selected. Finalisation still requires a current factual assessment and a measured document within the chosen limit.

Show a whole-CV word count with approximately 500–600 words as an advisory starting point for a one-page CV, never as a fit guarantee or hard validation cap. The actual selected template, body size and rendered pages decide whether it fits.

Constraint precedence is explicit: a targeted revision's own presentation controls the generated/rendered page limit; its Omit choices exclude writing sources; selected essential evidence is protected while explicitly omitted essential evidence remains an acknowledged gap; emphasis affects allocation and pruning without changing factual thresholds; Summarise bounds eligible prose to one sourced bullet; selected qualifications remain distinct. Actual PDF measurement is the final fit authority. An impossible combination is an actionable constraint conflict, not permission to restore omitted material, silently drop qualifications or shrink the font. Settings supplies future-build defaults rather than overwriting a saved CV's choices.

The confirmed three-to-two-page bug arose because preparation updated the brief while writing still read the older three-page library theme. The shared writing projection now overlays the per-CV presentation on the derived writing library. Tests also cover JSONB-independent default detection, repeated save/retry/rewrite/quiz continuation, and the separate manual-edit path: a three-page saved revision with a two-page limit remains visible/editable but cannot pass finalisation, and Check does not rewrite it.

### 4. Write concise, supported content

The Executive Summary aims for two to three rendered lines, identifying the relevant professional contribution and supported strengths. This is guidance measured in the selected template, not a universal character limit or a reason to truncate a claim. The editor shows an actionable length observation when it exceeds that guide.

Bullets lead with a supported result or contribution where evidence permits, then concise context. Use metrics and role terminology only when the evidence supports them. Absence of a metric is not a defect to repair with an invented number. Preserve scope, ownership and qualification caveats.

Optional competency signposts are short labels attached to individual supported bullets. They are structured text rendered in bold by the shared PDF path, not arbitrary Markdown or HTML. Include each label with its bullet in factual-audit text and semantic identity: structured presentation must not bypass unsupported-skill checks. Normal prose remains available.

Older roles can be summarised by explicit treatment or an offered recommendation; age alone never silently removes evidence. The hybrid presentation groups related achievements within their attributed roles, using competency signposts while retaining visible employer, title and dates. It does not combine achievements from different employers into anonymous claims. This provides competency-led scanning without abandoning a truthful career chronology.

Retain the existing recommendation of about ten distinct relevant skills across up to five dynamic categories, one or two words preferred and three allowed. Reuse relevant stored skills, do not pad unsupported suggestions, and retain explicit acceptance before saving new skills/categories to Experience. Ten is guidance across the whole CV, not ten per category or a destructive limit on historical content.

If the writer proposes a skill not yet in Experience, it becomes a durable, clearly unresolved opportunity to expand the library rather than the fatal end of an otherwise usable CV build. It stays outside printed content until accepted and is not silently inserted as a factual claim. The person can link it to confirmed eligible experience, answer a factual evidence question where needed, explicitly accept it into the library, or reject it. A skill explicitly typed by the person is different: retain their draft wording and mark it unverified with an add-to-library/evidence prompt; never silently drop it or treat it as an AI proposal. Draft progress and Save remain available; only reviewed, supported accepted wording can satisfy factual finalisation. Preserve the same build's one-credit accounting, original evidence identifiers, omitted-source policy and valid work already paid for. The final implementation record must state the exact continuation/acceptance behaviour.

### 5. Separate factual assurance from editorial usefulness

Review presents distinct areas: factual support; coverage of all essential requirements and chosen emphasis; first-page prominence; concision/repetition; supported role terminology; and readability/layout. No editorial heuristic changes factual verdicts, invents a hiring probability or implies a measured recruitment outcome.

Reuse and extend deterministic editorial checks. First-page and summary-line observations come from the actual renderer's layout report, tied to the exact saved content/template. Terminology checks distinguish already supported role language from missing evidence; they must not recommend keyword insertion as proof of capability. Readability reports concrete observations such as overlong bullets or crowded layout, not a pseudo-scientific score.

Show at most three prioritised, specific next actions, with a link to the affected entry/claim or control. Unsupported claims and missing essential evidence outrank cosmetic advice. Show fewer than three when there are fewer meaningful actions; do not manufacture busywork. Stale or absent assessment data is labelled rather than presented as current.

A quick-scan view shows the same saved revision's Executive Summary, actual first-page content/preview, attributed role headings and skills. It is not another generated summary and makes no promise about how long a recruiter spends reading.

### 6. Use uploaded LinkedIn evidence and omitted material responsibly

Offer a LinkedIn consistency panel using an explicitly selected, account-owned LinkedIn PDF/text import. A URL is never fetched. Keep the existing import and confirmation pipeline. Extracted text/proposals are evidence to inspect, not proof that an online profile is current.

Compare only explicit, attributable company/title/date/qualification fields where the imported source quote can be verified against retained extracted text and the matching entity is unambiguous. Show the CV/Experience value and uploaded wording together, labelled corroborating, needs review or unknown. Missing, ambiguous, unconfirmed or pruned source data must not produce a conflict assertion. Never infer per-row LinkedIn provenance from a merged library entry. If retained input is unavailable, invite re-upload. Choosing a comparison import does not mutate CV or Experience.

Offer interview preparation cards from confirmed supporting evidence excluded from this CV, retaining source entry IDs, employer and dates. The cards contain existing evidence and neutral preparation prompts, not invented STAR answers. Rank against current requirement mappings where available; otherwise label them as additional evidence rather than claiming role relevance. They do not enter the CV/PDF unless the person changes selection and saves a new revision.

### 7. Preserve fast saves and reuse work only where valid

Save stores a new editable revision immediately. It does not generate, fit or assess the CV, require a model/budget/build slot, or reserve a CV credit. Check measures the exact saved revision first and never rewrites manual content. If it already exceeds the selected limit, show the actual count and limit, keep it editable, and do not spend on provider assessment. Offer editing, summarising, omission, changing the limit or an explicit Rewrite. New Build and explicit Rewrite author/fit to the selected limit or leave an actionable unresolved fit outcome. Check otherwise assesses the saved wording under existing ownership, spending, credit, resume and finalisation safeguards. Accepted new skills retain the existing atomic Experience write and its background library tasks; this is not a claim that no background AI task can ever occur.

Use explicit input identities for targeting, semantic assessment and layout. Unchanged role extraction and evidence planning can be reused when their actual inputs are unchanged. A pure presentation change may reuse factual/requirement results only when exact claim text (including signposts), source evidence, rubric, model and prompt/review-version identities match; it must rerender layout and cannot simply stamp an old assessment as current. Wording, source, model, prompt or rubric changes invalidate the affected checks. The full finalisation identity remains strict. Keep existing durable batch checkpoints and fail-closed validation.

The current review route resolves model and reasoning effort and does not send a configurable provider service tier. The semantic identity covers those actual route dimensions, the review prompt version and `CV_REVIEW_VERSION`. Its optional service-tier input is also part of the identity if routing later supplies one; this is not a claim that a new tier setting has been introduced.

## Architecture and implementation ownership

| Boundary | Implementation |
| --- | --- |
| Shared domain | Versioned targeting contract, source-preserving selection projection, requirement confirmation, editorial actions and semantic/layout identities in client-safe core helpers where appropriate; schema validation remains server-side. |
| Persistence and queue | Additive draft targeting/preparation data and migration only where existing JSON content cannot represent a pre-content state safely. Transactional account/version checks, continuation action and queue deduplication. Legacy rows have no brief and retain existing defaults. |
| AI and worker | Feed the validated brief through planner/writer/fitter/improver, preserve complete factual evidence, resume at the preparation gate, reuse unchanged stages. Prompt/contracts update together. |
| Write and Review | Shared controls for treatment, emphasis and page guidance; immediate Save; distinct factual/editorial review, three actions, quick scan, uploaded-source consistency and interview cards. Avoid loading heavy PDF/schema code into the client bundle. |
| PDF | Structured signposts and renderer-derived layout observations; same output path for preview, measurement and final export. No unsupported HTML, clipping or changed historical stored exports. |

Keep supplementary review, LinkedIn and interview views server-rendered or loaded only when opened. Preserve the initial route budgets (CV 138,000 bytes gzip; Library 142,000). No additional default paid model stage is introduced: priority choices use the existing rubric, recommendations use the existing evidence plan, and added editorial/comparison/preparation views are deterministic. Record before/after save/projection/render measurements and provider-call counts rather than an assumed percentage speed-up.

The Executive Summary label must fit its real layout; it cannot simply replace the short Profile label in the existing narrow side column. Preserve legacy font/size behaviour and measure new output rather than claiming a font size the renderer does not use. Overflow guidance must distinguish Check (measure and assess saved wording) from an explicit Rewrite (generate and fit new wording); Save does neither.

Execution proceeds in coherent increments: first contracts and persistence/preparation; then selection and guided writing end to end; then measured review, LinkedIn/interview views and presentation; finally integrated verification. These are implementation steps for this accepted scope, not silently deferred features. The backend/core/worker executor and frontend/review/PDF executor agree contracts before editing shared files; one owner integrates server actions and shared schemas.

## Acceptance and evidence

| ID | Required result |
| --- | --- |
| A1 | Two CVs from the same library can have different Feature/Summarise/Omit choices. Library bytes/version and the other CV remain unchanged. Omitted sources retain original IDs and cannot reappear through fitting, improvement, summaries or skill generation. |
| A2 | Preparation offers three-to-five emphasis choices (or fewer when unavailable), retains every essential requirement, pauses without queue churn, and resumes exactly once after an authorised current confirmation. Stale/cross-account submissions fail. |
| A3 | An explicit essential-evidence omission is acknowledged and remains honestly visible as a coverage gap. No silent reintroduction or score-denominator reduction occurs. |
| A4 | New-build guidance offers one/two pages and override, visible word-count guidance and a new 12-point targeted template with explicit 11-point option. Explicit preferences and legacy/finalised 10-point CVs remain unchanged. Real PDFs verify one/two-page examples, overflow handling and readable text without automatic font squeezing. |
| A5 | Summary line observations use actual layout. Result-led writing, metrics, terminology and signposts preserve evidence citations and qualification. Invented metrics/ownership, omitted-source claims and cross-employer attribution are rejected by regressions/evaluation. |
| A6 | Summarised older roles and hybrid signposts retain employer/title/dates and visible attribution across page breaks. Education/Training headings remain distinct. |
| A7 | Skills retain approximately ten overall across at most five dynamic groups, allow fewer supported suggestions, preserve three-word labels and save only accepted additions. |
| A8 | Factual support, essential coverage and editorial observations remain distinct. Three-or-fewer ranked actions point to real issues; unsupported claims outrank cosmetic edits. Quick scan is tied to the exact saved rendered revision. |
| A9 | LinkedIn comparison uses only a selected owned uploaded source and verified quotes; ambiguous/missing/pruned input reports unknown/unavailable. Cross-account IDs fail and no URL request occurs. |
| A10 | Interview cards use confirmed omitted evidence with unchanged source/employer/date attribution. They never alter CV content or imply generated answers are facts. |
| A11 | Ordinary Save stays immediate with no CV task/model/credit admission. Check never calls the author or rewrites wording; known overflow is measured and actionable before provider spend. Check retains other safeguards. Equivalent semantic inputs can reuse factual results after rerender; changed claims/evidence/rubric cannot. Repeated saves and interrupted builds retain valid reusable work. |
| A12 | Legacy readers, migration, authorisation inventory, concurrency/idempotency, UI navigation, bundle budgets, production build, browser flows and real PDF rendering pass. Tests cover invalid/hostile imported text and stale proposal/source versions. |
| A13 | A model-proposed new skill is presented as an unresolved library-expansion opportunity instead of a terminal materialisation error. Rejecting it or explicitly linking/confirming/accepting it has an owned, idempotent continuation; no invented skill becomes trusted automatically, Save remains usable and the same build is not charged twice. |
| A14 | The confirmed per-CV page choice is authoritative throughout authoring, allocation, fitting, retry, preview and export. A preparation change from three to two pages reaches actual worker/render inputs. Manual overrun is visibly labelled with actual count versus hard limit and cannot finalise. Refresh reconciles targeting identities without a retry loop, and every bullet trim keeps citations/signposts aligned. |

Prompt changes require refreshed exact prompt-set metadata and genuine bounded synthetic live qualification before release readiness. Preserve historical reports and failed evidence. Offline fixtures must remain labelled unverified; they cannot satisfy the strict live release gate. Use no personal uploaded data for evaluation. Record actual model spend, calls/reused stages and measured layout. Do not claim faster model responses or improved hiring outcomes from local tests.

Reuse the existing bounded live-release evaluation harness and its spending guard. Its synthetic fixture must exercise a confirmed targeting brief, omission/summarisation, guided layout, concise summary and optional signposts; a legacy fixture with targeting absent is insufficient qualification for this change. Root owns the authorised live run and independent rasterised review of one-page, two-page, hybrid/signpost and unchanged legacy PDF fixtures after prompts/rendering freeze.

## Alternatives and consequences

Rejected: deleting or archiving Experience to shorten one CV; selecting priorities by keyword frequency; downgrading essentials to improve a score; a universal one-page rule; anonymous cross-employer competency claims; a combined truth/editorial score; automatic LinkedIn scraping; and paid regeneration on every edit.

The preparation step adds a deliberate decision before a new targeted build writes. The benefit is explicit control over what the document argues and predictable reuse; the cost is new persisted state and UI. Existing CVs stay readable and editable. LinkedIn comparison is deliberately limited by retained upload evidence and reports uncertainty honestly. Interview cards are grounded preparation rather than an additional generative answer product. General web-profile synchronisation, arbitrary freeform document templates and outcome prediction remain outside this decision; none is required for the accepted features above.

## Implementation and verification record

Implementation and local verification are complete. This record distinguishes that evidence from hosted CI and deployment; nothing here means that the functionality is already live.

| Acceptance | Implementation boundary | Verification status |
| --- | --- | --- |
| A1, A3 | Shared targeting projection, ordinary revision save, worker source view and essential-omission mapping | Core targeting, worker and owned-action tests pass. Full and eligible evidence remain separate; omitted evidence cannot ground new writing or skill suggestions, while the full plan retains honest essential coverage. |
| A2 | Durable preparation status, server-owned confirmation and existing credit/task lifecycle | Synthetic queue pause → owned confirmation → resumed build and record/replay tests pass. Browser confirmation verifies three-to-two pages, Summarise/Omit and one continuation on the same draft. |
| A4, A6 | Versioned targeted body-size setting, measured PDF report and attributed signposts | Legacy raster unchanged; independent one/two-page visual checks pass. The long fixture is a layout stress test, not evidence of AI writing quality. |
| A5 | Writer contracts, signpost-aware claims and source validation | Renewed bounded targeted qualification passes at prompt set `951386df60b9` with eligible claim evidence and unchanged recorded author requests. All nine printed claims are supported. The live summary measures four lines, honestly triggering the advisory shortening observation rather than a false two/three-line claim. |
| A7 | Existing skill selection flow with targeting-aware source eligibility | Policy-hash and omitted-row regressions pass; the live eligible-source probe verifies ten suggestions across four categories without padding. |
| A8 | Deterministic review actions, exact claim-page report and quick scan | Focused helpers cover selected-emphasis support on page one/later/unknown, supported terminology and measured readability. Browser preparation navigation passes. |
| A9 | Account-owned retained-upload comparison | Quote/date-precision and positive confirmed-source-marker checks pass. Unconfirmed, dismissed, merged or pruned sources without that marker remain unknown. No profile URL fetch is introduced. |
| A10 | Source-linked omitted-evidence interview cards | Focused helpers preserve exact confirmed row attribution and distinguish mapped from additional evidence. These are existing facts and neutral prompts, not generated interview answers. |
| A11 | Shared immediate Save, explicit Check, strict semantic/layout identities and preserved plans | Worker tests pass for overflow without provider calls and layout-only reuse with fresh measurement. Browser Save/Check/preview/finalisation/download flows pass. Full and eligible evidence changes invalidate the cache independently. |
| A12 | Migration, authorisation inventory, broad suites, build/bundles, browser flows, PDF and live evaluation | Core 779/779, AI 205/205, DB 119/119 and worker 871/871 pass. Initial full web: 1,633/1,639; six intended-contract fixture failures were repaired and affected web/auth tests pass 289/289 plus route inventory 8/8. Fresh migration and legacy upgrade pass. Renewed targeted live qualification and strict gate pass. Final production build, all bundle budgets and full browser smoke pass after the last fit guard and client split. Hosted CI remains the exact-commit gate. |
| A13 | Pending new-skill opportunity, explicit evidence-linked acceptance and safe continuation | Tests cover existing confirmed evidence, a newly confirmed example, inactive/omitted-source boundaries, ownership and replay conflicts. Browser rejection preserves Experience. Acceptance writes a free child revision; a new factual check remains explicit. |
| A14 | Authoritative constraint projection, refresh/retry reconciliation, visible overrun and aligned bullet fitting | Three-to-two projection and same-draft failed-fit recovery pass. Fit suite 34/34 includes seven distinct qualifications retained under tight prose budgets, index-aligned citations/signposts after pruning and emphasis-weighted selection. |

Migration 0063 adds nullable targeting, pending-skill and semantic-audit data. Apply the migration before new web readers, deploy a worker that recognises the preparation state before enabling the new UI, and verify worker/web commit identities after rollout. A legacy read fallback is defence in depth, not a substitute for this deployment order. Final verification must apply the complete migration to a fresh database, because its unpublished definition changed during development. No production migration or deployment has been performed by this implementation task.

The representative legacy fixture is retained locally at `/tmp/col-cv-legacy-fixture-1030.json`; its initial renderer output is one A4 page and 3,590 bytes. A single local cold render took 16 ms. This is a diagnostic baseline, not a latency SLA or a comparison against provider work. Final visual and performance results will be recorded against the final source revision.

The independently inspected targeted layout stress fixture at `/tmp/col-cv-targeted-long-1030.pdf` renders as two A4 pages with 542 printed words including headings, a 12-point body and 11-point skills. It contains ten skills across five categories, distinct qualifications and deliberately repeated synthetic role bullets. It verifies pagination, attribution, readable sizing and absence of clipping/orphan headings; it does not qualify generated prose or establish a universal words-per-page rule.

On Node 22.18.0 in a warm local process, the same synthetic fixture has 12 sections, approximately 5.1 KB of input JSON and a 6,014-byte two-page PDF. Fifty pure targeting projections measured approximately 0.01 ms at both p50 and p95; twenty actual PDF renders measured 3.72 ms p50 and 5.68 ms p95. These are diagnostic in-process measurements, not hosted latency, provider latency or a before/after speed claim. The more important tested work-avoidance contracts are that ordinary Save queues no CV check, known overflow makes no provider call, and an eligible layout-only change reuses the existing factual audit after fresh measurement.

The final local browser smoke measured one manual Save at 79 ms from click to the persisted ready revision, with zero queued CV model tasks. This is one synthetic local diagnostic sample, not an SLA, hosted measurement or comparative speed-up. Route-manifest bundle budgets also pass: CV 125,039 of 138,000 bytes gzip with two large chunks (limit two), and Library 141,457 of 142,000. Dynamic editor chunks may still load when rendered, so these figures do not claim total hydration-byte savings.

The initial bounded targeted live run used invented evidence, confirmed choices and the new template. It made four CV calls (two author and two review) and two skill calls; rubric/evidence planning reused the synthetic fixture's cached results. It produced one measured page within the selected two-page limit, nine supported printed claims and ten verified skill suggestions across four categories. Exact offline replay had zero misses and passed its grade. Initial transport spend was $0.882678.

After correcting targeted claim review to use eligible evidence while retaining full-library requirement verdicts, the final qualification reused both exact recorded author responses and made two fresh review calls plus two fresh skill calls. Ordered response reuse checks model, prompt and input hashes; it is recorded provider evidence, not a scripted live answer. Final qualification passes with ten suggestions across four categories and a readable one-page PDF within the chosen two-page limit. Its four-line summary triggers the measured editorial shortening advice. Incremental spend was $0.471457, for cumulative actual provider spend of $1.354135 within the same $10 ledger. Original evidence remains under `/tmp/col-cv-targeted-eval-1030`; final evidence is under `/tmp/col-cv-targeted-eval-final-1030`. Cached planning was not independently exercised live, and nothing was deployed.

After the last qualification-preservation fit guard, an offline replay of the final provider recording passed all four grade invariants with zero misses and one page within the two-page limit. It made no provider calls and confirms that the recorded author/review requests still match the final fit path. Repository qualification evidence is in `docs/evaluations/cv-targeted-2026-10-30/`.

The subsequent requested skills-spacing refinement applies to newly rendered targeted and legacy drafts: vertical pill padding is 2 pt, wrapped-row spacing is 2 pt, and the gap between categories is 4 pt. Font sizes, horizontal geometry and industry pills are unchanged. Stored finalised PDF bytes remain immutable. Before/after renders of the supplied five-category, 21-skill example in both Course of Life and Arial retain all 26 pills, identical extracted text, font sizes and wrapped-row counts, while reducing the skills block's height by 23.8–25.6%. Independent raster review found no clipping or overlap. The focused pill/fit suite passes 44/44, the web PDF suite 29/29, and core typechecking passes. This spacing-only change adds no model calls or prompt changes; the earlier live PDF remains historical qualification evidence.
