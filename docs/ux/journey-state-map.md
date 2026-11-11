# Jobs, states and recovery paths

This is the cross-product state review accompanying ADR 0005. It separates the user's job from background work and saved records. A CV being ready does not mean an application was submitted; a successful upload does not mean evidence was confirmed; a followed company with no fetched roles is not necessarily a company with no vacancies.

## Design contract

- Keep three primary destinations: Find roles, Applications and Experience. Following/discovery sit within Find roles; search learning sits within Preferences.
- A state tells the person what is available now and the next useful action. Detail explains a refusal only when it affects that action.
- Show existing results during refresh. Distinguish queued work, active work, a decision waiting for the person and a recoverable failure. Never invent a progress percentage.
- Keep user-owned decisions separate from processing: shortlist, save career facts, approve a CV and record submission are explicit actions.
- A partial result is usable with its limitation visible. Do not label missing information as an empty result or silently replace a saved document.
- Put recovery beside the failed item. Provider, queue and infrastructure diagnostics belong in Operations, not member-facing error copy.
- Warnings guide; they do not veto a renderable CV that the owner deliberately approves. Ownership, invalid data, stale saves and running-build conflicts remain technical guards.

## State inventory

The tables describe the intended contract, including existing behaviour that must be preserved. They are not claims that every row received a new screen in this change. The concrete CV consolidation is specified in ADR 0005; remaining discovery and onboarding design opportunities are identified separately below.

| Job / destination | State | User sees | Primary action / next transition | Recovery and preserved data |
| --- | --- | --- | --- | --- |
| Find suitable roles / Matches | No preferences yet | A short filter setup, not an apparently empty search | Save filters → matching can run | Preserve entered values on refusal |
| Find suitable roles / Matches | No followed sources | Private career-based catalogue recommendations where available, otherwise an honest empty state | Discover matching roles or follow a company | Keep filters; no follow is required to see eligible catalogue matches |
| Find suitable roles / Matches | Loading or refreshing | Existing rows plus quiet activity; first load uses a stable placeholder | Review available rows | A failed refresh retains prior rows and the last successful check |
| Find suitable roles / Matches | No matching roles | No matches for the current filters | Adjust filters; Following is secondary | Distinguish zero matches from unavailable source data |
| Find suitable roles / Matches | Results ready | Role, employer, relevant status and shortlist control | Shortlist → Applications | Dismiss and archive remain reversible where supported |
| Follow an employer / Discover companies | Candidate not followed | Company identity and follow action | Follow → subscription saved | Duplicate follow reuses the existing catalogue identity |
| Follow an employer / Following | Connection queued or working | Followed status plus connection activity | Review other companies while waiting | Do not ask users to repeat Follow |
| Follow an employer / Following | Careers source needs confirmation | Company row with one local correction action | Confirm/add careers URL | Preserve company and subscription; no new catalogue row |
| Follow an employer / Following | Connected, no fetched roles | Last successful check and role count | Open employer or wait for scheduled check | Do not infer successful connection from an empty failed scan |
| Follow an employer / Following | Partial scan | Available roles and incomplete-check indication | Review available roles; retry is secondary | Retain previously known roles until removal is confirmed |
| Follow an employer / Following | Connection/check failed | Plain-language issue on that company | Retry or correct source, according to the failure | Technical attempt history remains in Operations |
| Follow an employer / Following | Paused | Paused monitoring, retained company and roles | Resume | Pausing is not unfollowing or deleting evidence |
| Bring an external role / Add a role | Input | Link, document or pasted details | Import/review role | Invalid input is reported inline without clearing it |
| Bring an external role / Add a role | Processing | Saved import with resumable status | Continue later | Reopening resumes the saved import rather than creates a duplicate |
| Bring an external role / Add a role | Partial or inaccessible advert | Available text and the missing requirement | Supply/correct the description | Preserve the source and previous extraction |
| Bring an external role / Add a role | Ready for confirmation | Editable role details | Confirm → saved opportunity | Confirmation does not submit an application |
| Maintain facts / Experience | No evidence | One import chooser and manual entry | Import a source | LinkedIn is an export upload or pasted text, never an implied URL ingestion |
| Maintain facts / Experience | Upload/import processing | Source name and current import state | Continue other work | A saved import can be reopened |
| Maintain facts / Experience | Imported rows ready | Selected source rows and provenance | Add selected rows once → saved career record | Unselected/model-only suggestions are not promoted; no second confirmation |
| Maintain facts / Experience | Import failed | Source-specific retry or correction | Retry, replace input or dismiss | Keep saved Experience and unsaved choices |
| Maintain facts / Experience | Saved | Editable reusable facts with source/provenance | Edit or add detail | User facts are usable by default; changing them does not rewrite existing CVs |
| Prepare an application / CV | No saved CV | Auto and Manual entry, with cost clear | Build Auto or start Manual | No compulsory questionnaire before the first usable CV |
| Prepare an application / Auto | Queued/working | Progress distinct from the selected saved version | Continue editing/reviewing a saved version | Completion makes a result available without taking over the editor |
| Prepare an application / Auto | Same inputs | Existing baseline | Open/use saved result | No new credit, task or generation |
| Prepare an application / Auto | Sources changed | What changed and an explicit update action | Update → new retained baseline | Retain old baselines and all Manual editions |
| Prepare an application / Auto | Failed | Recoverable message and saved editions | Retry when supported | No fabricated successful result; existing credit/refund rules apply |
| Tailor this role / Refine | Unmodified item | CV wording in context | Edit wording or give an instruction | The action states whether it is exact text or generation |
| Tailor this role / Refine | Remembered change | Visible marker at the item, with reset | Save and update CV for exact changes; explicitly generate for instructions | Scope is this application only; no implicit global learning |
| Tailor this role / Refine | Source changed | Compatible choices and explicit conflicts | Review/update bindings, then apply | Never attach by array position or silently accept changed evidence |
| Tailor this role / Refine | Reset | Baseline wording/choice restored | Continue editing | Reset one/all leaves Experience and saved editions intact |
| Finish wording / Manual | Unsaved | Current text plus unsaved state | Save this version | Mode switches preserve the buffer; navigation guards against loss |
| Finish wording / Manual | Saved | Saved version and preview | Review final PDF | No model call and no reusable refinement/evidence writes |
| Review a CV / Feedback | Unchecked or stale | Honest check state, optional Check | Review final PDF; Check is secondary | Do not present old findings as a current assessment |
| Review a CV / Feedback | Current findings | Findings beside the relevant content | Edit or acknowledge at approval | Check never rewrites words |
| Approve a CV | Ready, renderable | Measured PDF, page count and warnings | Acknowledge and finalise | Approval binds the exact saved version; stale approval fails clearly |
| Approve a CV | Finalised | Download and selected version | Download or record submission | Final PDF bytes never change; further editing creates a version |
| Pursue an opportunity / Applications | Preparing | Exact application context and selected CV | Open workspace | Same-title opportunities remain distinct |
| Pursue an opportunity / Applications | Submitted | Explicit submission record and final CV | Update application stage | A build alone never marks a role Applied |
| Pursue an opportunity / Applications | Interview/outcome/closed | Stage, relevant date and next task | Update stage or reopen | Retain submitted document and history |
| Any workspace | Expired session / unavailable service | Clear recovery without internal diagnostics | Sign in again or retry | Do not claim an uncertain save succeeded; recover saved data after reconnect |

## Where simplification has the greatest value

| Area | Source of avoidable work | Consolidation decision |
| --- | --- | --- |
| CV editing | Choosing among mode, edition, multiple Layout panels and multiple approval controls | One selected-version state, contextual edits, shared Layout and one approval destination |
| Refine | Translating a target dropdown and generic structured payload into the actual document | Select the visible item; show what is remembered and reset it beside that item |
| Source updates | Discovering a conflict only after asking to generate | Preview changed role/evidence and compatible/conflicting choices before applying them |
| Comparison | Reading two documents to infer omissions and choices | Explicit added/removed/changed/order/priority/layout differences |
| Evidence import | Several entry forms appear to promise different ingestion behaviours | One source chooser leading to the same selected-row save lifecycle |
| Following | Operational scan states compete with the person's role-discovery goal | Company row leads with roles available and one actionable issue; diagnostics stay secondary |
| Applications | CV progress and application stage can be mistaken for the same state | Separate preparation from explicit submission/outcome while retaining one opportunity row |

CV consolidation and navigation/import contracts are part of this follow-up. A replacement discovery screen, new matching algorithm, onboarding redesign or automated application submission is not implied. Those require separate scoped decisions; preserve their existing controls and recovery routes here.

## Task-based validation

Automated browser checks must exercise user decisions, not merely the presence of headings:

1. Open a saved Auto CV twice: identify the same version and observe no new task/credit.
2. Edit a visible, prefilled summary and save it once. The current saved CV must contain the edit without a separate Apply step or model call. Forget only that change for future builds; the current wording, other remembered choices and Experience must survive.
3. Change the role description/evidence and follow the guided update from the current CV. Review compatible refinements and conflicts after the new source is ready, without selecting internal source/destination IDs in the normal path. Confirm that no old target is attached to a new item silently.
4. Compare results with a removed experience, reordered skills, changed Essential criterion and font/page choice. Each change must be visible in the comparison.
5. Change Layout through one shared entry point; its persistence follows the selected mode. No disabled duplicate control sends the person elsewhere.
6. Type Manual wording, visit other modes and return. Save without generating. Rebuild separately and recover the saved Manual version.
7. Follow a legacy Feedback/Layout fragment and a Check action to the correct visible destination, including keyboard focus.
8. Finalise an unchecked or warning-bearing saved CV once, with acknowledgement. Download bytes must equal approved bytes; a later edit cannot mutate them.
9. Record submission for that exact opportunity and final CV. Check that preparation alone never changed application stage.
10. Repeat critical actions at 390 px and with keyboard navigation; ensure lazy loading has an announced state and does not erase input.

Browser checks establish functional completion and recoverability, not human comprehension. Before claiming the design is intuitive, ask representative users to perform the tasks without instructions. Record completion, wrong turns, requested help, time to first usable CV and whether they correctly predict which edits survive a rebuild. In particular ask them to explain Auto/Refine/Manual, distinguish Save from Apply, and identify the final document. No usability-study results are claimed by this document.

## Evidence and release boundary

Record exact automated journeys and remaining exceptions in ADR 0005. Report measured local/hosted latency as observations, not general speed promises. Keep frontend bundle budgets and no-generation-on-save assertions as release gates. Real-user validation, production migration and deployment are separate activities and must be reported honestly when they have not occurred.


## Approved simplification pass after PR 134

Functional correctness is necessary but does not establish an intuitive journey. This pass retains the three editing modes and their persistence guarantees while reducing the decisions needed for common tasks. The following journeys are implemented and covered by the automated verification recorded in ADR 0005; human comprehension remains untested.

| Task | Previous user work | Required simplified journey |
| --- | --- | --- |
| Change exact wording | Find item → type/copy wording → save refinement → apply refinements | Open prefilled item → edit → Save and update CV; confirm the saved CV changed |
| Keep a writing instruction | Save instruction, with its application state inferred from other controls | Save instruction → explicit paid generation when wanted; never charge from an exact Save |
| Know which CV will be approved | Reconcile active mode, selected edition, remembered changes and approval panel | Current saved CV identity and state remain explicit; primary action follows the active unsaved work or next review step |
| Update after new evidence/role | Update Auto → select source/destination → preview mappings → accept → apply | Update Auto → review source changes → carry the compatible set once → explicitly apply or generate remaining changes; advanced source selection remains secondary |
| Find an older result | Infer differences from repeated Auto labels and dates | Recognisable mode, version, time and source context, with a clear current marker |
| Recover edits after a source changes | Copy wording or reselect an earlier source manually | Restore original saved edition directly and continue with the retained wording; copying remains an optional fallback |

Count meaningful decisions and required actions, not only clicks: moving a button or collapsing a panel does not remove a conceptual step. Measure a fresh CV and a realistic long CV on desktop and phone. Avoid introducing automatic paid generation, automatic evidence promotion or silent source acceptance to reduce apparent steps.

The production-browser fixture verifies two successive exact saves using one remembered rule, no redundant Apply step, recovery of dirty wording after selecting a different source, one compatible-set confirmation with real conflicts retained, unchanged final PDF bytes, and keyboard access at 390 px without horizontal overflow or browser errors. It uses synthetic content with two sections, so it does not establish long-document comprehension or production latency. A local run measured the exact save at 112 ms and Manual save at 48 ms; neither queued model work or consumed a new CV credit.

### Human comprehension check still required

Ask representative users to complete these tasks without narrating the interface or explaining the modes:

1. Build a CV for the supplied role, then locate the document they would send.
2. Change one summary sentence and verify it appears in their saved CV.
3. Keep a role-specific preference, then make an independent final wording edit. Predict which survives a rebuild.
4. Update Experience and produce an updated CV while keeping a previous final version recoverable.
5. Resolve one changed-source refinement, reset another, and finalise despite an acknowledged warning.

Record completion without help, wrong turns, help requests, time to first usable CV, whether an unintended build/credit occurs, and whether the participant correctly identifies the current final document and the scope of each edit. Analyse errors individually rather than presenting a small sample as a population success rate. Automated browser acceptance and local timings must remain separate from these human observations. No participants or results are claimed by this document.


## Approved role access and direct editing follow-up (ADR 0008)

Contract: [ADR 0008](../adr/0008-role-entitlements-and-contextual-editing.md). The following changes are implemented and locally exercised by the production-browser and automated checks recorded in ADR 0008. Hosted checks and the strict live prompt qualification gate remain pending; human comprehension is untested. These changes supersede disclosures and confirmation wording in older rows where inconsistent.

| Task | Visible surface and next action | Accounting and recovery |
| --- | --- | --- |
| Start a role | Role identity, existing access or one-credit first AI request | Duplicate owned catalogue-role contexts share access; Manual starts free |
| Edit the current CV | One Current CV, mode/save state, directly editable text and visible layout controls | Exact Save is free; Auto remains immutable; dirty buffers survive navigation |
| Ask for writing help | Visible pixel star; dark tooltip “Help me write”; three-action menu only | Quote correction/refinement/tailoring units, or first-role credit, before request |
| Review a suggestion | Inline before/after, Use change and Dismiss | Successful generation uses the quoted charge; acceptance is free; stale targets cannot be overwritten |
| Update source or whole CV | Named source-update task showing actual changes and cost | Existing role uses editing allowance; cached results free; old editions preserved |
| Inspect history/compare/remembered choices | Named task destination with clear return to current document | No duplicated hidden baseline/edition lists; return preserves dirty state |
| Maintain Experience | Visible records, factual fields, public/private controls and tags | Durable factual save free; no new Experience AI tool in this phase |
| Review Experience differences | Persistent local review destination and quiet account count | No mass acknowledgement or mandatory resolution gate |
| Track an application | Opportunity, selected CV, stage and next action | Preparing/payment never means Submitted |
| Allowance exhausted | Always-visible session and weekly bars with exact resets; free controls remain usable | No forced purchase/check; saves, export and valid unchecked finalisation continue |
| Work fails/cancels | Local Retry/status and intact original content | Failed system work does not consume quota; retry identity prevents duplicate charge |

No accordions, `details`, “More options” or explainer paragraphs remain in the scoped CV, Experience, Applications and opportunity preparation surfaces. Essential controls remain visible; infrequent controls move to clearly named task screens. The writing menu is the explicit exception. Admin screens are not part of this redesign.

The local validation covers Manual-based AI, duplicate role accounting, successive direct edits, scoped tool requests, accepting/dismissing/stale suggestions, quota with continued free saving, source/history/reset handovers, 390 px/320 px writing controls and unchanged final PDF bytes; see ADR 0008 for exact suite scope and broad-run exceptions. Compare completion steps and wrong turns in a later real-person study; no comprehension claims follow from automated browser results.

## Shared frontend interaction follow-up

The [design system](../DESIGN-SYSTEM.md) now defines the common task-navigation and save-state contracts used across the CV and Experience workspaces. Local tasks share keyboard navigation and linked panels while retaining unsent input. Save acknowledgement refers to the submitted snapshot; subsequent edits remain visibly unsaved. Phone layouts preserve readable source text as well as containing controls within the viewport. These changes consolidate the existing tasks rather than changing their AI, credit, evidence or finalisation policies. Human task comprehension remains to be evaluated with the protocol above.

## Opportunity screen follow-up

The next screen pass consolidates Applications filters without merging their meanings: Progress answers which applications are active or closed, Next steps answers what is due, and Stage records what happened. All remain URL-backed links; selected states and company scope remain visible. Empty filtered results offer a route back without silently clearing the company. The complete due list is one click away, replacing the duplicate three-item preview. Add a role opens the dedicated `/applications/new` task; the working application list starts with its filters and results rather than a full entry form.

Companies list management links remain navigation; interactive management belongs on the company page. Roles shares one setup snapshot across checklist and empty-state guidance. Companies and Applications have named loading states, and unexpected page failures have a guarded retry. Application update navigation must preserve unsaved input when leaving is cancelled, including typing that occurs while an earlier save is pending. The production browser checks cover scoped recovery, cancelled dirty navigation, validation recovery and free creation without AI work; mobile text width is checked alongside control bounds. Exact automated results and measured bundle/query changes are recorded in the design-system follow-up; human comprehension remains untested.
