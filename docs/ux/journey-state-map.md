# Jobs, states and recovery paths

This is the cross-product state review accompanying ADR 0005. It separates the user's job from background work and saved records. A CV being ready does not mean an application was submitted; a successful upload does not mean evidence was confirmed; a followed company with no fetched roles is not necessarily a company with no vacancies.

## Design contract

- Keep three primary destinations: Find roles, Applications and Experience. Following/discovery sit within Find roles; search learning sits within Preferences.
- A state tells the person what is available now and the next useful action. Detail explains a refusal only when it affects that action.
- Show existing results during refresh. Distinguish queued work, active work, a decision waiting for the person and a recoverable failure. Never invent a progress percentage.
- Keep user-owned decisions separate from processing: shortlist, confirm evidence, approve a CV and record submission are explicit actions.
- A partial result is usable with its limitation visible. Do not label missing information as an empty result or silently replace a saved document.
- Put recovery beside the failed item. Provider, queue and infrastructure diagnostics belong in Operations, not member-facing error copy.
- Warnings guide; they do not veto a renderable CV that the owner deliberately approves. Ownership, invalid data, stale saves and running-build conflicts remain technical guards.

## State inventory

The tables describe the intended contract, including existing behaviour that must be preserved. They are not claims that every row received a new screen in this change. The concrete CV consolidation is specified in ADR 0005; remaining discovery and onboarding design opportunities are identified separately below.

| Job / destination | State | User sees | Primary action / next transition | Recovery and preserved data |
| --- | --- | --- | --- | --- |
| Find suitable roles / Matches | No preferences yet | A short filter setup, not an apparently empty search | Save filters → matching can run | Preserve entered values on refusal |
| Find suitable roles / Matches | No followed sources | Empty state with a route into discovery | Follow a company | Keep filters |
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
| Maintain facts / Experience | Proposals ready | Proposed facts, duplicates/conflicts and source | Confirm selected facts → new library version | Unselected/unconfirmed material is not usable evidence |
| Maintain facts / Experience | Import failed | Source-specific retry or correction | Retry, replace input or dismiss | Keep existing confirmed evidence and unsaved review choices |
| Maintain facts / Experience | Confirmed | Editable reusable facts with source/provenance | Save evidence | A change offers a new CV build; it does not rewrite existing CVs |
| Prepare an application / CV | No saved CV | Auto and Manual entry, with cost clear | Build Auto or start Manual | No compulsory questionnaire before the first usable CV |
| Prepare an application / Auto | Queued/working | Progress distinct from the selected saved version | Continue editing/reviewing a saved version | Completion makes a result available without taking over the editor |
| Prepare an application / Auto | Same inputs | Existing baseline | Open/use saved result | No new credit, task or generation |
| Prepare an application / Auto | Sources changed | What changed and an explicit update action | Update → new retained baseline | Retain old baselines and all Manual editions |
| Prepare an application / Auto | Failed | Recoverable message and saved editions | Retry when supported | No fabricated successful result; existing credit/refund rules apply |
| Tailor this role / Refine | Unmodified item | CV wording in context | Edit wording or give an instruction | The action states whether it is exact text or generation |
| Tailor this role / Refine | Remembered change | Visible marker at the item, with reset | Apply saved choices | Scope is this application only; no implicit global learning |
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
| Evidence import | Several entry forms appear to promise different ingestion behaviours | One source chooser leading to the same proposal/confirmation lifecycle |
| Following | Operational scan states compete with the person's role-discovery goal | Company row leads with roles available and one actionable issue; diagnostics stay secondary |
| Applications | CV progress and application stage can be mistaken for the same state | Separate preparation from explicit submission/outcome while retaining one opportunity row |

CV consolidation and navigation/import contracts are part of this follow-up. A replacement discovery screen, new matching algorithm, onboarding redesign or automated application submission is not implied. Those require separate scoped decisions; preserve their existing controls and recovery routes here.

## Task-based validation

Automated browser checks must exercise user decisions, not merely the presence of headings:

1. Open a saved Auto CV twice: identify the same version and observe no new task/credit.
2. Edit a visible summary, remember it for the role, apply it, then reset only that change. Other remembered choices and Experience must survive.
3. Change the role description/evidence; inspect compatible refinements and conflicts before rebuilding. Confirm that no old target is attached to a new item silently.
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
