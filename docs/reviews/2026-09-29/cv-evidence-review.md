# CV and Library product review — 29 September 2026

Reviewed at `ebb346b` against `CLAUDE.md`, `docs/SPEC.md` (especially CV builder, R-7.13, R-7.14 and Appendix D), and `docs/UX-JOURNEYS.md` journeys 4 and 5. This is a code and evidence review, not a production usability study. No application code or database state was changed for this review.

## Verdict

The two jobs are substantially implemented. A person can save an evidence Library, build a role-specific CV from confirmed evidence, inspect its factual audit, edit and reassess it, finalise a PDF, and request comments on an expiring preview. A document can produce an anchored, per-item Library proposal. The main acceptance risk is now at the edges: one import field can assert an unsupported current role, conflict recovery can throw away text, and an import that stalls does not become actionable in an open tab. These merit correction before calling the journeys fully reliable.

Scores use 0 = absent and 5 = complete and demonstrated. Robustness reflects observed guards and tests, not a claim about production operations.

| Journey | Completeness | Robustness | UX simplicity | Assessment |
|---|---:|---:|---:|---|
| 4. CV from role to final PDF, including sharing | 4/5 | 3.5/5 | 3.5/5 | Core path, price, status, revision, audit, PDF and comment loop exist. End-to-end paid quality at shipped prompts remains unverified. |
| 5. Evidence Library, scoring and import | 4/5 | 3/5 | 3/5 | Save, confirmation, guidance, optional re-score, import and archived recovery exist. Import grounding and safe conflict recovery have the failures below; editing remains dense. |

## Findings, in order of impact

1. **P1 — Imported employment can be marked “Current” against a document with an explicit end date.** `validateLibraryProposal` anchors the start date and would anchor the end date, but trusts `job.current === true` and then forcibly blanks the end date (`packages/core/src/library-import.ts:348-352`). I reproduced this with the document line `Director of Operations, Acme Logistics, Mar 2020 – Jun 2022` and an otherwise anchored model proposal containing `current: true`: the accepted proposal was `current: true, endDate: ""`. The proposal card consequently displays `Present` (`apps/web/lib/library-import.ts:136-142`), and acceptance saves that flag (`packages/core/src/library-import.ts:503-510`). This is precisely the kind of unsupported career fact the import contract forbids. Only set current when the job heading explicitly says Present/current, and refuse or clear it when an end date is present. Add a regression test with a completed role and a contradictory model flag.

2. **P1 — “Reload and keep my text” drops conflicting edits with no accessible copy.** On a version conflict, `mergeById` replaces a concurrently edited block with the stored block and only records its label (`apps/web/lib/cv-library-merge.ts:73-85`). The fallback for an invalid merge likewise returns the stored Library (`:131-138`). Both paths tell the person their discarded wording is “in the download” (`:137`, `:152-155`); the Library page and editor expose no Library download (`apps/web/app/(app)/library/page.tsx:52-81`, `apps/web/components/CvLibraryEditor.tsx:269-463`). `reloadAndKeep` then replaces the editor value (`apps/web/components/CvLibraryEditor.tsx:194-208`), so a second tab changing the same job can make unsaved text unrecoverable after the person presses the purported recovery control. The unit test explicitly expects the misleading download sentence (`apps/web/lib/cv-library-merge.test.ts:48-58`). Keep each conflicting local value in a visible copy/reapply panel or downloadable draft before replacing the editor; test this in the component interaction, not only as a pure merge.

3. **P2 — A stalled import never becomes actionable automatically in an open tab.** The card offers Dismiss only after 15 minutes (`apps/web/lib/library-import.ts:103-118`; `apps/web/components/LibraryImportProposals.tsx:29-45`). The polling hook stops after 10 minutes (`apps/web/components/useVisiblePoll.ts:89-115`), and its signature changes only when database state changes (`apps/web/lib/queries/library-imports.ts:46-56`), not when elapsed time crosses 15 minutes. If the worker leaves the row untouched, the page remains on “Reading your document…” indefinitely until a manual navigation or reload. Continue a bounded poll through the stall threshold or use a local timer to refresh the card at 15 minutes; verify with fake time and an unchanged import signature.

4. **P2 — The pre-build price is stale when a replacement advert is pasted.** The Applications form lets the person paste up to 60,000 characters but displays the server quote for the stored advert unchanged (`apps/web/components/ApplicationsTable.tsx:206-238`; `apps/web/app/(app)/applications/page.tsx:69-76`). The action recalculates from the pasted text and can refuse before queueing (`apps/web/app/actions/cv.ts:375-406`). Thus the button can show an affordable “about $X” for a larger advert that the action refuses. Re-price after the replacement changes, or clearly mark the displayed quote as for the stored advert and update it before enabling Build.

5. **P2 — A first document import may require manual Library creation despite a full CV upload.** Acceptance refuses to create a Library if the account has no saved Library and `user.name` is empty (`apps/web/app/actions/library-import.ts:186-190`); the import proposal contains jobs, qualifications and skills but no name field (`packages/core/src/library-import.ts:66-91`). This means the “start from a CV” path can send a new account back to the empty editor for a separate save. This may be rare if registration always supplies a name, so it needs an account fixture before treating it as widespread. An explicit name field at acceptance would close the path without guessing a name from the document.

### Standalone reproductions and existing mitigations

The import counterexample uses the pure `validateLibraryProposal` function. The input document and relevant model proposal are:

```text
Document: Director of Operations, Acme Logistics, Mar 2020 – Jun 2022
          • Ran a team of 30
Proposal: { company: "Acme Logistics", title: "Director of Operations",
            startDate: "2020-03", endDate: "2022-06", current: true,
            quote: "Director of Operations, Acme Logistics, Mar 2020 – Jun 2022",
            responsibilities: [{ text: "Ran a team of 30" }] }
Output:   { startDate: "2020-03", endDate: "", current: true, ... }
```

Executed with `pnpm exec tsx -e` importing `packages/core/src/library-import.ts`; the full output also retained the anchored employer, title, quote and responsibility. The proposal UI would say `Mar 2020 – Present`. The person can untick the entire job or correct its dates after acceptance, and rows arrive unconfirmed. Those are manual mitigations; the default all-ticked proposal still suggests an unsupported fact and can persist it without a per-field date confirmation.

The conflict counterexample uses the pure `mergeCvLibrary` function with one saved evidence block (`ev-1`, Northwind · Head of Operations):

```text
Base v8:       "Led four managers."
My unsaved v8: "Led four managers and eighteen schedulers."
Saved v9:      "Led four operations managers."
After reload:  "Led four operations managers."
Dropped:       ["Northwind · Head of Operations"]
Notice:        "Reloaded version 9 and found nothing of yours to carry across.
                Check it, then save again. Northwind · Head of Operations was
                changed in the saved version, so the saved wording is what you
                see; your version is in the download."
```

Executed with `pnpm exec tsx -e` importing `apps/web/lib/cv-library-merge.ts`. The optimistic version check prevents the initial stale save from overwriting v9 (`apps/web/lib/cv-library-write.ts:48-53`), and immutable stored versions retain wording that was **previously saved** (`docs/SPEC.md:837`). Neither protects the quoted unsaved local v8 wording: it was never stored, and `reloadAndKeep` replaces its client value with the merged result. The page has no Library export/download (`apps/web/app/(app)/library/page.tsx:52-81`), `/api/cv/library` returns only the newest stored version (`apps/web/app/api/cv/library/route.ts:18-33`), and the current SPEC intentionally omits a version list (`docs/SPEC.md:837`). The user could manually copy the unsaved text before invoking recovery, but the control does not warn them to do so.

## What works and what the evidence supports

- The Library saves immutable versions behind an account lock and rejects obsolete writes (`apps/web/lib/cv-library-write.ts:41-63`). The editor shows unsaved changes, Save/Discard, navigation prompts, per-job readiness and Confirm all (`apps/web/components/CvLibraryEditor.tsx:153-180`, `:269-300`, `:350-357`). Archived jobs can be restored (`:423-440`). The employment grid has a phone card layout (`apps/web/components/EmploymentHistoryTable.tsx:45-99`). Version history is intentionally no longer displayed under the current SPEC (`docs/SPEC.md:837`), so this is not a missing feature.
- A normal Library save gives rule-based evidence feedback immediately; a paid model review is a deliberate Re-score. The review computes scores in core, checks row quotes and preserves a rules baseline when the model cannot answer (`packages/core/src/library-review.ts:149-214`, `:332-369`; `apps/web/app/actions/cv.ts:121-163`; `apps/worker/src/handlers/library-review.ts:111-143`, `:168-203`). Scores inform and do not gate use. This meets the amended contract, though a user may still need help understanding why a score changed after re-tagging.
- CV admission checks the confirmed Library, role access, full advert and account budget before creating a draft; the worker remains the authority for per-stage spending (`apps/web/app/actions/cv.ts:344-485`). The CV review requires every printed claim to be accounted for and anchored to confirmed source evidence, and finalisation refuses stale assessment, page overflow or a flagged factual claim (`packages/core/src/cv-review.ts:153-212`, `:317-341`; `apps/web/app/actions/cv.ts:739-790`). These are strong structural checks, but a quote can be semantically misread by a model; finalisation therefore still needs the human review the UI asks for.
- The evaluation table separates factual, gap and reader comment rows, gives a route to add evidence, and keeps comments out of score calculations (`apps/web/lib/cv-evaluation.ts:10-76`, `:101-129`; `apps/web/components/CvEvaluationTable.tsx:129-213`). Applications CV status polls during a build (`apps/web/app/(app)/applications/page.tsx:96-108`, `:143-146`). Direct Edits and Rebuild have explanations and cost estimates (`apps/web/components/CvDraftEditor.tsx:189-223`). The workspace has many tabs and dense evaluation rows, so a moderated first-time run is needed before awarding a higher simplicity score.
- Import converts PDF/DOCX/website/paste in the worker, bounds file and extracted text, uses polite website fetching, anchors proposal text, and saves only selected additions through the Library version path (`apps/web/app/actions/library-import.ts:58-153`, `:168-204`; `apps/worker/src/handlers/library-import.ts:83-200`, `:208-255`; `packages/core/src/library-import.ts:287-401`, `:479-565`). The current-role counterexample above is an exception to that otherwise careful grounding.
- Sharing uses a random token stored only as a hash, owner-scoped content projection, expiry/revocation, no-store middleware and per-token/address throttles; comments are capped, anchor-checked and rechecked against a live share at write time (`apps/web/app/actions/cv-share.ts:43-79`; `apps/web/lib/queries/cv-shares.ts:57-95`; `apps/web/middleware.ts:22-35`; `apps/web/app/share/[token]/comments/route.ts:60-116`; `packages/db/src/cv-shares.ts:170-193`). A link is shown only at creation. Reader comments are opinions and never enter the model path.

The 20 September synthetic tailoring contrast executed a provider model for three roles and passed its automated checks, but its baseline is a literal Library-derived control and its blinded human review remains blank (`docs/evaluations/cv-tailoring-contrast/README.md`). The currently committed CV replay report at the shipped prompt set is explicitly **unverified**: it uses a scripted client and measures the record/replay/grade mechanism, not live model quality (`docs/evaluations/cv-replay/README.md`, `report.json`). Neither source proves production factual accuracy, hiring value, actual cost or p95 latency. The Library import and evidence review likewise have fixtures and code checks; I found no committed paid-provider acceptance run for those flows.

## Acceptance gates for sufficient completeness

1. **Honesty:** a completed role with a model-supplied `current: true` cannot enter a proposal as Present; dates, employer/title, each row, qualification and skill remain anchored. Confirmed Library evidence and every printed CV claim are validated as currently specified. Exercise adversarial and ordinary CV/LinkedIn/website samples.
2. **No lost writing:** two tabs edit the same Library block; the second save is rejected; recovery visibly preserves or exports every local conflicting field and can merge unrelated edits. Cover invalid merge and navigation with unsaved text.
3. **Import completion:** every import resolves to proposal, actionable refusal or actionable stalled state while the page stays open. Duplicate upload, restart, timeout, budget refusal, unsupported format and a changed Library version each have a clear recovery path.
4. **Cost clarity and build recovery:** a pasted advert changes the displayed estimate before submission; the action and worker still refuse unaffordable work without a stranded draft. Exercise queued, failed, quiz pause, direct edit, rebuild, reassess, finalise and immutable PDF download in an integrated environment.
5. **Sharing boundary:** live, expired, revoked and archived links; comment permission; invalid anchors; throttling; no-store headers; and owner-only comment resolution pass route-level tests. Verify the public page contains only the CV content and link comments.
6. **Model quality:** replay a fresh recording from the paid provider at the current prompt set on representative roles and imperfect Libraries; publish source-grounding errors, unsupported-claim rate, coverage, page fit, costs and latency. Have people blind-review the PDFs and complete a first-time Library→CV→comment→finalise walkthrough. Treat scores and editorial heuristics as aids, not hiring predictions.

## Ordered roadmap

1. Correct and test the imported `current` flag grounding; then repair conflict recovery so it cannot discard text while promising a nonexistent download.
2. Make the stalled import state appear at 15 minutes and make replacement-advert pricing react to what will actually be submitted.
3. Close the empty-name import path and run a first-account walkthrough on phone and desktop, simplifying the Library’s densest evidence controls where the walkthrough shows hesitation.
4. Run the current paid-provider CV/import/review evaluation and blinded PDF review. Calibrate any quality or cost claims from those results, then re-score completeness and robustness.

Verification in this review: 89 focused core tests and 58 focused web tests passed. They are unit/component tests, not database or paid-provider tests. A direct `tsx` reproduction confirmed the unsupported `current: true` proposal. No database suites were run here; the parent review is coordinating those.
