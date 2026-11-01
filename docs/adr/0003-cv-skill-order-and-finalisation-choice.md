# ADR 0003 — CV skill order and explicit finalisation choice

Status: Accepted, 1 November 2026. Supersedes ADR 0001's non-overridable manual page-overrun/factual finalisation rules and its Check-before-overflow-stop policy. Implemented and verified locally; hosted CI and deployment remain separate gates.

## Decision

The CV belongs to its author. The system reports factual, relevance, omitted-evidence and layout findings; an explicit, current acknowledgement may accept them without changing or deleting those findings. Ownership, exact revision/assessment identity, an idle saved revision and a valid render remain technical prerequisites.

### Skill order

Write offers accessible Move up/down controls for both skill categories and the individual skills within each category. The existing ordered section/item arrays remain the saved document contract. A submitted category order is a validated permutation of the current CV's skill IDs; it cannot reorder employment or insert foreign sections. Old forms without an ordering field preserve their existing order.

Preview, free Save, Check and PDF output use the same order. Experience's reusable Library order is unchanged. Explicit Rewrite retains a bounded hint of the validated CV's skill order across retries/continuations. It applies only to matching sections and skills that the new draft actually selects; new selected skills append, and missing or omitted skills are never restored by the ordering hint. Rewrite still derives factual content from eligible Experience and fits to the chosen page limit.

### Review and finalisation

Check measures and assesses the exact saved wording, including a renderable document exceeding the preferred page count. It records the actual count and does not author, shorten or silently change the document. New generation and Rewrite continue to enforce their fitting constraints.

For a current assessment with unresolved findings, Review shows those findings and a single **Finalise with warnings** action. Its required checkbox explicitly acknowledges the findings and measured page count. Without such findings the action remains **Finalise this CV**. The server requires the acknowledgement and the current assessment identity; it records the override while preserving the assessment, score, evidence and warnings. In particular, a summary that may refer to omitted Experience is a warning, not an absolute finalisation veto.

Finalisation renders and stores the exact approved PDF atomically. A positive, valid rendered document may exceed the preferred page limit only through this explicit acknowledgement. It does not claim that the document fits. Missing/stale assessment, a running or paused build, foreign ownership, malformed/unrenderable content and stale confirmation remain refusals. Finalised stored bytes remain immutable and downloads/applications use those bytes.

## Acceptance

- Category and item moves retain exact order in preview, saved revisions, Check and PDF; employment chronology is unchanged.
- Invalid, duplicate or foreign category IDs fail rather than silently changing the document. Existing un-ordered forms remain compatible.
- Rewrite applies matching user order before fitting/measurement, survives checkpoint reset/retry and does not reintroduce omitted skills.
- Factual, omitted-summary and page-overrun warnings can be explicitly acknowledged; findings and actual page counts remain visible and stored.
- An overlong saved revision can complete Check without author calls, then be finalised with acknowledgement; generation/Rewrite still fit normally.
- Missing acknowledgement, stale assessment/revision, foreign ownership, in-flight work and invalid PDF conditions still fail without partial publication.

No prompt text, paid provider evaluation or database migration is required for these control and lifecycle changes.

## Verification

Finalisation checks passed: 29 worker CV tests, 29 core review/targeting tests and 12 Review UI tests. The complete action integration file subsequently passed all 40 tests, including the skill-order addition. The integration path covers a failed page-limit revision completing Check without authoring, becoming ready with the actual overrun, explicit acknowledgement, and download of its stored approved PDF. Invalid and mismatched rendered page counts, stale assessment and locked-render races remain refusals.

Skill-order checks passed: four core tests and 43 editor/projection tests, plus core, worker and web typechecks. The added worker Rewrite regression passed independently (29 existing tests excluded by its name filter; the earlier full 29-test run is recorded above). These cover selected-only order, unchanged cited bullet/source pairs, a skill moved beyond the six-bullet boundary, actual fitting/rendering and legacy 11–20-item checkpoint compatibility. Production build and all route bundle budgets passed (CV route: 125,425 gzip bytes against 138,000).

The final production browser smoke passed all pages and flows, including reordered skills in preview, free Save and reload; finalisation, dismissal, explicit warning override and PDF download. Desktop/mobile visual inspection confirmed clear arrow controls and no horizontal overflow. One local free Save took 117 ms from click to persisted revision and queued no model task; this is a diagnostic observation, not a production latency guarantee. The synthetic finalisation fixture now uses its actual rendered page count, so the new stale-layout guard is exercised without an inaccurate hard-coded assessment.

No live provider call is needed for this deterministic behaviour; existing factual review and generation fitting remain in force. Historical finalised PDFs remain unchanged.
