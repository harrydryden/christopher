# CV build review — 28 October 2026

This review follows the Training, supporting-section, skill suggestion, editable category and budget-recovery changes. It covers the path from editing a CV to saving, generating, assessing and rendering it. The work focuses on demonstrated correctness or efficiency issues rather than changing model prompts or splitting files solely because they are large. The user also requested a simpler path for saving draft edits, so ordinary Save is separated from the explicit CV check.

## Architecture and contracts

| Area | Main implementation | Contract |
| --- | --- | --- |
| Write and preview | `apps/web/components/CvDraftEditor.tsx`, `apps/web/lib/cv-review-edits.ts` | The preview and save must apply the same wording, section selection and provenance rules. Skill suggestions use the current pre-suggestion draft context. |
| Save and accept skills | `apps/web/app/actions/cv.ts`, `apps/web/lib/cv-skill-accept.ts` | Ownership, library version and suggestion input are checked before committing a new revision. Category edits affect the CV; only explicitly accepted suggestions add skills to Experience. |
| Generate and resume | `apps/worker/src/handlers/cv.ts`, `cv-stages.ts` | Each paid stage is admitted against spending limits, fenced by task ownership and saved under its input/model/prompt identity. Reuse must not bypass validation. |
| Assess | `packages/ai/src/engine.ts`, `cv-review-batch.ts` | Independent audit batches already run concurrently after the first response begins. Claims must retain their exact evidence attribution; final assembly validates coverage and grounding. |
| Progress | `apps/web/lib/queries/cv.ts`, `cv-progress.ts`, `cv-build-state.ts` | Account-scoped progress and journal signatures remain consistent, including queue retries, resumable work and older schemas. |
| PDF and finalisation | `apps/web/lib/cv-pdf.ts`, `cv-pdf-store.ts`, finalisation actions | Preview follows the edited content. Finalised exports are immutable; a changed CV creates a revision and requires a current assessment. |

## Baseline evidence

Read-only production observations over the previous 14 days, from a small sample: evidence planning took 125.5 seconds (one observation), rubric generation 53.4 seconds (one), audit batches had a median of 53.1 seconds and p95 of 71 seconds (12), and PDF rendering took 143 milliseconds (two). These are diagnostic observations, not a performance SLA or a statistically reliable comparison.

Three stored production checkpoints averaged 57,404 bytes, with a maximum of 61,583 bytes. The progress query was selecting the complete checkpoint on each poll, despite the interface needing only resumability facts. Applying the new SQL projection read-only to those same three records produced an average 42-byte checkpoint field. This measures that field alone on the database-to-web-server path, not the entire endpoint response, browser payload or page latency.

Provider work dominates observed build time. This review therefore prioritises preserving completed paid work and reducing redundant browser/progress work; it does not claim that local refactoring makes provider inference faster.

## Confirmed findings and changes

The following changes address reproduced defects or avoidable work. No prompt text, prompt identity, concurrency level or stage-key format changed.

- The worker and model engine independently implemented audit partitioning. Their indices must stay identical for admission, saved batch reuse and final assembly.
- The worker saved successful audit batches only after the whole concurrent pass returned. A worker loss before that point could discard a completed paid batch.
- The editor repeatedly projected sections and serialised draft content during unrelated suggestion polling updates.
- Preview and save differed on summary trimming, summary provenance and obsolete fit notes. A blank skill heading that was then removed could pass client projection but still be rejected by server validation.
- Progress polling selected full checkpoint content instead of only the facts used by the progress interface. This affects database-to-server transfer and server allocation; the progress API already omitted the full checkpoint from its browser response.
- Ordinary Save previously queued another CV assessment and was gated by build capacity/model configuration. The new path stores an editable ready revision immediately; Check remains a deliberate action with its existing safeguards. A saved revision only reuses an assessment that is still current for its exact content and evidence.
- Successive unchecked revisions must carry their source rubric and any still-valid evidence plan without an unbounded ancestry lookup.

## Invariants reviewed

The changes must preserve account ownership, verified-account requirements, CV credit reservations and refunds, spending admission, checkpoint fencing, evidence grounding, suggestion acceptance and library version checks. Audit concurrency already exists and is retained; changing its level or reducing evidence checks is outside this refactor. No production data mutation, budget increase, provider call or deployment is part of this work.

Raw stage-key hashing was also inspected. Current paid stage inputs are rebuilt through deterministic parsers/mappers; no confirmed real-stage ordering defect justified invalidating existing hashes. Any future key change must preserve compatibility with already paid checkpoints.

## Save, check and retention

Saving manual wording does not generate or assess the CV and needs no CV credit reservation or build-capacity slot. The separate Check action measures/fits and assesses the saved revision under the existing model, spending, ownership and concurrency checks. Rewriting remains a separate paid operation. Finalisation still requires a current assessment and all existing safety checks.

Plain Save does not run completion retention: unchecked revisions must not delete a previously approved CV. Retention remains at successful explicit check/publication. Accepted new skills still update Experience atomically and may trigger its existing library-review or scoring tasks; “no automatic CV assessment” does not mean no background activity anywhere in the account.

## Verification

- Core: 762 tests passed; AI: 205 passed; worker CV build, tailoring and stage suites: 60 passed on disposable local PostgreSQL.
- The durable-batch regression observes `audit[0]` in PostgreSQL while the second batch is unresolved; retry calls only the latter (three total stubbed provider calls instead of four). Separate tests cover awaited persistence failure and cancellation of siblings.
- Focused web editor/shared-projection tests: 33 passed; CV save/progress database tests: 33 passed; web typecheck passed. Real database saves cover ready revisions without automatic CV tasks, explicit Check, JSONB-safe duplicate handling, distinct edits, finalised-source copying, source rubric/plan propagation and Experience isolation.
- The synthetic progress fixture measured 176,123 bytes for the full checkpoint versus 61 bytes for its projection. The editor regression confirms that a queued-to-running suggestion poll does not call the content projection again. These are local work/payload measurements, not production latency claims.
- The saved draft’s own evidence plan is checked first, then its immediate parent’s, with rubric and evidence validation in both cases; a deleted parent does not force a valid copied plan to be lost.
- Production web build and all bundle budgets passed. The CV route is 134,566 bytes gzip against a 138,000-byte budget, 232 bytes above the preceding implementation.
- Strict verified evaluation gate passes at prompt set `987e0b5ac958`; release checks pass (139 tests and two expected database skips). No paid live evaluation was needed because prompts and model contracts are unchanged.
- Final browser and broad web suite results are recorded before review submission.

## Remaining limits

Model response time remains the largest observed component. Fresh live performance claims require a representative, authorised evaluation; the read-only baseline and local regression evidence cannot establish a new production wall-clock improvement. A process can still fail between receiving a provider response and committing its checkpoint; this boundary cannot be eliminated by an in-process callback. The aim is to persist each validated result promptly rather than wait for all siblings.
