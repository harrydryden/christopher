# CV refactor review — 30 October 2026

## Scope and decision

This review follows ADR 0001 and covers the CV editor, supporting evidence and skills, revision save/rewrite/check actions, preparation views, targeting controls, worker stages and checkpoints, factual-cache identity, page fitting and finalisation. The implementation extends PR 121. It does not change the accepted writing or assessment prompts.

The review prioritises inconsistent behaviour and avoidable work across boundaries. Shared projections, source identities and lifecycle locks remain the architecture: the editor previews the same content that Save commits, the worker validates evidence against the exact saved source, and PDF measurement decides page fit. Large handlers are not split solely to reduce their line counts; no new persistence framework or global mutable-draft cache is introduced.

## Findings and changes

| Finding | Resolution | Required evidence |
| --- | --- | --- |
| Save parsed indexed form fields against a row read before the lifecycle lock, then copied metadata from that old row. Recovery could change the same revision while the editor remained open. | Bind the form to the saved content and targeting identity. Check that identity again under the lock, derive revision metadata from the freshly locked row, and ask a stale editor to reload. | Changed-content and changed-targeting rejection; no accidental task, credit or revision; unchanged repeated saves and copying finalised wording. |
| A same-draft page refresh could replace the hidden Save identity while React retained older unsaved rows. | Keep the mounted editor's content, targeting choices, section mappings and revision identity together. A changed saved base blocks Save/Rewrite with a reload notice and retains typed wording. Library-only or assessment metadata updates leave ordinary Save available. | Same-ID refresh tests retain the original hidden identity and user wording, disable ordinary and selected-skill Save for a changed base, and keep the original library version for evidence-dependent actions. |
| Competency labels followed textarea positions when bullets moved or disappeared. | Reconcile labels with their claims in the editor and shared save projection. Preserve unambiguous moves and single-line edits; clear ambiguous assignments and explain the change. | Deletion, insertion, reordering, duplicate text and ambiguous replacement tests; preview/save agreement. |
| Linking a pending skill to existing evidence assumed entry IDs contained no colons. LinkedIn imports use compound IDs. | Parse the final row suffix and resolve the selection against the actual active, eligible entry and confirmed row. | Imported IDs accepted; unknown, inactive, unconfirmed and omitted rows refused. |
| Pending-skill acceptance could add a sixth skills category while normal editing enforced five. | Apply the same category-limit rule to acceptance, including compatibility for existing older CVs. | Sixth-category refusal rolls back both CV and library changes; existing categories remain editable. |
| The editor's omission warning tracked entry references only. A profile-only essential could lose its support without offering the acknowledgement required by the server. | Retain profile dependence in the targeting view and use the same omission policy when calculating affected essentials. | Profile-only, entry-only and mixed-source cases agree between controls and server validation. |
| Detail and preparation pages fetched their already-owned full draft again inside view helpers. The second read could also describe a different recovery state. | Build views from the page's account-owned saved snapshot, retaining account scoping on supplementary plan queries. | View tests prove that another full draft read is unnecessary; pages retain the existing account-owned lookup before deriving views. |
| Ordinary wording saves fetched and parsed the latest full Experience library even though they use the draft's saved evidence. Supporting-section IDs were also parsed twice. | Validate supporting choices once and fetch current supporting evidence only when sections are being added. Skills, remembered wording and Rewrite retain their own current-library work. | Ordinary Save makes no latest-library lookup; malformed selections fail before that lookup; current Training selection and stale-version refusal still work. |

## Processing contracts retained

- Ordinary Save persists a ready revision without provider calls, a queued CV task or a CV credit. Check assesses saved wording; Rewrite remains an explicit separate action.
- Actual PDF measurement enforces the saved page choice. Neither an editorial word count nor a font reduction substitutes for that measurement.
- Role extraction, evidence planning, audit batches and layout-only factual reuse retain their existing identities and validation. Evidence, wording, policy, model or prompt changes invalidate the relevant work.
- Targeted omissions restrict new writing and skill grounding while keeping the complete evidence snapshot available for honest requirement assessment and interview preparation.
- Finalised downloads retain their approved stored PDF bytes. Legacy content remains readable and editable.

## Performance interpretation

The page-read change removes one full draft-row read from each affected page request and prevents its controls being assembled from a second mutable snapshot. Ordinary wording Save also avoids one latest-library query, its full-content parsing and supporting-section projection. These are explicit work-avoidance results, not a hosted latency percentage. No model concurrency or prompt change is justified by this review: the existing stage runner already checkpoints and reuses validated work, and manual Save already avoids AI processing.

## Verification

Local verification passes:

- Frontend/projection/targeting/read-view regressions: 42/42. Explicit profile dependence is distinct from entry IDs, including an entry whose ID is itself `source:profile`. Ambiguous duplicate bullets clear their labels instead of guessing which occurrence survived.
- Save/build action tests: 27/27, including actual changes between the initial read and transaction. A newly completed assessment is copied from the locked row, and changed saved wording is rejected before creating a child revision.
- Pending-skill action tests: 5/5; other affected CV action/lifecycle suites: 112/112.
- After the final ordinary-Save optimisation, the Save/build and skill/support integration suites pass 39/39. They assert no latest-library lookup for ordinary saves or malformed supporting choices, plus successful current-version Training selection and stale-version refusal.
- The subsequent same-ID refresh regressions pass in the final editor suite (25/25): changed content and targeting retain the original form identity, ordinary/skill Save and Rewrite are fenced, and metadata/library-only refreshes preserve editing. The broader affected action suites also pass 111/111 after the Save optimisation.
- Core/web typechecks, evaluation-script typecheck, prompt-report gate and whitespace checks pass. The React review found no new client-side crypto or schema dependency.
- The production build and all route bundle budgets pass. CV first-load JavaScript is 125,183/138,000 bytes gzip; Library is 141,458/142,000.
- The final local production-browser check passes using a separate synthetic account: free Save, no queued CV task or provider call, preserved two-page choice, measured summary guidance and invalidation after editing, review-link focus, and no horizontal overflow at 390 px. One Save sample took 94 ms; this is neither a hosted measurement nor a comparative speed claim. See `refactor-browser.json`.
- Exact offline replay passes all four invariants with zero recording misses at prompt set `951386df60b9`, with one rendered page inside the two-page limit. See `refactor-replay.json`. Its cost fields describe the historical recorded calls; this replay incurred no new provider spend.

Hosted CI remains the exact-commit gate on PR 121. The earlier live qualification remains historical evidence; this offline replay is not a new paid AI evaluation. No additional migration or provider qualification is required for these prompt-preserving changes. Application rollout still requires merging PR 121 and verifying the resulting worker and web deployments.

An editor tab opened before this release lacks the new saved-content identity and must reload before saving. The action reports that explicitly. It does not apply indexed fields to a source that may have changed.
