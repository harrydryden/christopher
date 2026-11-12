# ADR 0009 — Versioned CV execution, contextual retrieval and persistent build activity

Status: Accepted for implementation. Verification and remaining rollout gates are recorded at the end; acceptance is not a claim of production deployment.

## Context

A CV build is both a user workflow and a bounded model execution. The current system already has immutable Auto input identities, account-owned application contexts, Refine overlays, independent Manual editions, stage checkpoints, a build journal, source validation, measured fitting, accounting and separate author/reviewer calls. Adding an unrelated orchestration framework would duplicate those contracts.

The user needs to leave the CV screen without losing progress or completion, and needs high-quality relevant first drafts without repeatedly explaining the same career. Word-overlap selection can miss differently phrased achievements. Conversely, inferred search labels must not become self-corroborating evidence. Large prompts and general agent loops are not automatic solutions.

## Decision and compatibility

Extend the existing implementation with three coordinated layers: a versioned execution manifest, contextual retrieval, and account-wide durable activity. The journal and persisted result remain authoritative. Reuse current database, queue, model adapters, shared shell and design tokens.

This supplements ADRs 0001–0008. ADR 0005's Auto/Refine/Manual separation, explicit finalisation with overridable editorial warnings and preservation of dirty edits remain binding. ADR 0007's career graph and privacy, and ADR 0008's role credit/AI allowance and source-backed skill provenance remain binding. A notification is not approval, an inferred tag is not a fact, and a build completion is not automatic finalisation.

### Precedence

1. Account ownership, valid references, source revisions and protection of saved/unsaved user work are invariants.
2. The explicitly selected source and user choices govern inclusion, ordering and permissible disclosure.
3. Exact wording locks are applied deterministically. Instructions may influence only unlocked targets.
4. Ranked role priorities guide selection and emphasis; Essential is an independent coverage flag, not permission to invent evidence.
5. Page/font constraints govern measured output. If locks and layout conflict, retain the source and explain the conflict rather than silently dropping or rewriting locks.
6. Optional model judgement is advisory. Editorial findings remain overridable under the existing finalisation acknowledgement contract; failed rendering or foreign-account access is not overridable.

Auto remains a stored immutable result for a complete versioned identity, not a promise that stochastic generation repeats bit-for-bit. Refine stores reusable role preferences; Manual wording never silently enters the career library. Optional improvement candidates do not replace an actively edited edition.

## A. CV execution harness

### One manifest composed with existing snapshots

Persist a versioned execution manifest in the existing JSON checkpoint before paid stages. Reference the draft's immutable role/library/selection/overlay inputs instead of maintaining a second mutable copy. Record input identity, stage contract versions, prompt set, resolved model/effort routes, fit/render versions and bounded stage policy. Preserve enough identity to distinguish a resumed execution from a new source build.

The manifest complements, rather than replaces, each checkpoint stage's input key. A previously completed stage is reused only when its full dependencies and contract still match. An incompatible deployment must fail recoverably or explicitly start a compatible new execution; it must not relabel an old artefact as having run under a new contract. Legacy checkpoints without a manifest retain their compatibility path and acquire a manifest only from known current inputs; historical approval bytes remain untouched. Generic legacy retries may legitimately refresh their source: their manifest retains the first `inputKey` and records `currentInputKey`, while per-stage dependency keys control reuse. Auto/Refine identities remain strict. Fully resolved model/effort routes stay pinned; pre-manifest generic checkpoints may repeat a stage once when their old route key cannot prove compatibility.

### Execution and changes

Models propose typed output; application code validates and applies it. Existing stable source and target IDs govern provenance and exact-wording changes. A late response cannot overwrite a newer revision. Each stage has a finite attempt/deadline budget and admission against existing account/role allowances. Provider failure resumes completed work. Full generation remains in the worker.

Retain current rubric → evidence plan → writing/fitting → assessment/publication dependencies. Parallelise only independent work. Keep current scoped audit retries, claim memoisation and layout-only semantic audit reuse. Do not run additional agents or whole-CV rewrites merely to seek a marginal score gain. Changed text still receives appropriate checking; unchanged inline edits retain the deterministic no-verifier-call shortcut.

### Provider boundary

The execution specification records actual resolved routes and contracts; the existing engine remains the provider boundary. This change does not claim to implement an unconfigured provider or promise transparent fallback across incompatible structured-output/caching capabilities. Provider substitution requires adapter conformance and the same quality corpus. Any future fallback must record its actual route, obey the remaining budget, and invalidate incompatible reusable results.

## B. Career representation and retrieval

### Three kinds of information

Preserve original source/narrative, structured user statements, and derived retrieval hints separately. Existing records, assertions, dates, contexts, perspectives and links remain the source of truth. Search aliases or concept labels influence recall only: they must never appear as factual citations, change ownership/scope, or be promoted because another model repeated them.

Use record identity and relationships to retain employer/client/project/time context, including concurrent consultancy and fractional roles. Contextual text must not broaden confidential visibility. A private parent/relationship stays private even if its public child contains matching terminology. Existing conflict decisions remain version-bound and non-blocking at the account level.

### Initial retrieval implementation

Introduce a versioned deterministic retrieval contract combining exact lexical matching, conservative capability aliases and linked career context. Use actual ranked role requirements where available, not a dormant standalone helper. Rank complementary coverage so multiple strong statements about one requirement do not crowd out evidence of another. Preserve stable tie-breaks, explicit selections, chronology/project presentation and existing capacity constraints. Apply retrieval hints before truncation, never after a relevant statement has already been dropped.

Small eligible libraries remain available whole within existing capacity; larger libraries use the scored selection path. Essential/rank weights guide selection without inventing coverage. The downstream semantic evidence planner and source validators still adjudicate whether retrieved text supports the requirement. Tests must include synonyms, unsupported near-matches, parallel projects, explicit ordering/selection, privacy and sparse evidence.

This first implementation is lexical/concept/relationship retrieval, **not neural embedding search**. Neural hybrid retrieval is an extension point and a separate evaluated rollout gate, because no embedding provider or quality calibration has been approved/configured for this repository. Do not add speculative vectors or label keyword matching as embeddings. Before enabling it, define model/version/dimensions, per-account indexing and deletion, incremental revision updates, stale-index fallback, source preservation and a corpus comparison against the deterministic baseline. ESCO may map aliases and skills later, but must not become a hard gate on user language or proof of proficiency.

### Incremental generation and elicitation

Keep existing snapshots and dependency-aware reuse. A font change requires geometry/export; a wording change invalidates the affected claim and any whole-document checks that depend on it. A new source may alter retrieval across requirements, so do not assume only its own paragraph changes. Exact saved edits remain cheap deterministic saves.

Existing optional gap questions remain skippable. Future question ranking should maximise likely decision value (ownership/scope or role emphasis), not generic completeness. Answers explicitly supplied as career facts follow the existing direct-user save path; role preferences remain role-scoped. This ADR does not permit silently promoting Manual wording or model-only statements.

## C. One account-wide activity surface

### Read model and durable events

Expose a bounded, authenticated account-wide activity read (up to 50 active builds and 50 unread terminal notices from the last 30 days) containing active CVs and unread completion/failure events. Carry draft/context identity, company/role label, canonical lifecycle/stage and relevant timestamps. Do not return private provider errors, prompts, source documents or raw model text.

Write terminal activity durably with the draft's status transition, using an additive database migration so all publication/failure paths share the contract. Deduplicate by the exact execution/result identity and terminal outcome. Exclude ordinary synchronous free draft saves from build-completion notifications. Repeated writes must not duplicate the same event. Do not backfill old CVs into a storm of notifications.

Acknowledgement is account-owned and idempotent. Cross-account IDs behave as unavailable. A dismissed event is removed from the header, not from the CV or Applications. An unread result survives reload, navigation and a browser restart. If the referenced draft has legitimately been removed, the activity must not link to another revision under the same title.

### Header and progress

Mount one CV activity subscriber in the authenticated shell. CV activity takes precedence over routine scanning in the existing status strip; do not stack another large banner. With no active/unread CV activity, show the existing scan surface. Multiple builds use a compact count and link to Applications rather than a disclosure or list of operational logs.

Show the role/company, one plain-language current state, a compact progress bar and one next action. The stage model is Prepare → Write → Fit → Check. Stages show the current phase, not an invented time percentage; a bounded repair can revisit an earlier phase. Unknown/queued work is indeterminate; a known stage exposes stage position. Completion is 100% only after the result is saved. Retry/waiting/failure must be named instead of an endless 99% animation. No completion state waits on optional post-publication improvements.

Do not display elapsed seconds, attempt counters or provider details in the global strip. Existing detailed build diagnostics remain administrator concerns. Time estimates require calibrated observations and an uncertainty range; this initial UI must not fabricate an ETA.

Active build links open that exact workspace/revision. Ready events expose a direct CV link; opening or explicit dismissal acknowledges the event without marking the document approved. Acknowledgement failure preserves the link and offers retry; it must never prevent opening the CV. No automatic navigation, focus stealing or wholesale route refresh when an event arrives.

### Delivery and resilience

Use one visibility-aware, bounded-payload poller for the shared activity summary. Poll more frequently during active builds, back off otherwise and on errors, pause while hidden and refresh on return/navigation. On the build detail route its existing detailed delta feed can continue; the global read is a lightweight account summary, not a duplicate full journal download. Future SSE transport may replace polling without changing the read/event contracts.

Initial server state must not emit a fresh toast for every historical unread event. A newly observed terminal transition gets a polite completion announcement; the ready strip remains until acknowledgement. Persisted events are the reliable notification channel. Browser/OS push and closed-browser delivery are explicitly not implemented in this increment: they require deliberate permission, a service worker and delivery infrastructure. No permission prompt is shown on login and no email is sent.

Respect reduced motion. Keep reserved strip height and mobile wrapping to avoid layout shifts/overflow. Announce stage changes and terminal states via a polite live region, not every animation frame. A progressbar needs an accessible label and stage-valued description. Colour alone cannot identify ready/failed state.

## D. Evaluation and rollout

Verify auth before reads, tenant isolation, atomic/deduplicated terminal events, manual-save exclusion, stale IDs, retry transitions and idempotent acknowledgement. Exercise navigation, completion while elsewhere, reconnect, unread persistence, no repeated announcements, multiple builds, mobile layout and no dirty-editor overwrite.

For the harness, verify deterministic manifest identity, resolved-route capture, source/contract mismatch handling, legacy checkpoints, successful reuse, changed dependency invalidation and bounded stages. Preserve role-credit/allowance tests.

For retrieval, compare against the prior scorer with source-backed cases and inspect changes. Metrics are requirement evidence recall, unsupported scope, complementary coverage, user edits, first-fit success, p50/p95 time-to-usable-result and total tokens/cost including retries. Never use author self-scoring as the sole quality gate. The existing strict live AI qualification remains required before enabling changed generation behaviour in production; local mocks do not satisfy it.

Roll out additive schema before application code that reads it. Deploy worker/web contracts compatibly, then verify a synthetic complete build and account activity. No production migration, release, neural embedding service, external notifications or paid evaluation is implied by local implementation status.

## Sources and rationale

- [NN/g: long waits and interruptions](https://www.nngroup.com/articles/designing-for-waits-and-interruptions/): meaningful status and background work.
- [W3C ARIA25](https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA25): announce progress without moving focus.
- [Contextual retrieval](https://www.anthropic.com/engineering/contextual-retrieval) and [Late Chunking](https://arxiv.org/abs/2409.04701): context-preserving retrieval; neither establishes a universal CV configuration.
- [LongMemEval](https://arxiv.org/abs/2410.10813): indexing, temporal reasoning and updated information deserve separate tests.
- [OntologyBench](https://arxiv.org/abs/2609.08174) and [OntoLearner](https://arxiv.org/abs/2607.01977): similarity/model scale alone does not guarantee relational correctness; domain results must not be asserted as CV benchmarks.
- [Decisive](https://aclanthology.org/2026.acl-long.1465/): decision-valued elicitation motivates later question ranking.

## Coherence review

The new manifest references existing snapshots; it does not establish another editable source. Retrieval hints never acquire factual authority. Durable activity reports publication, not assessment approval. Auto/Refine/Manual semantics, free saves, role billing and editorial overrides remain unchanged. No unconfigured model, transport or notification channel is represented as working. Neural retrieval, adaptive elicitation and provider replacement remain explicit follow-on gates, not hidden implementation claims.

## Implementation evidence

Implemented in the existing checkpoint/worker, career projection, additive migration `0076_cv_activity.sql`, authenticated activity route and shared sticky header. The SQL query fetches only the latest journal stage and queue task per active draft. The server uses the existing detail-page state machine for waiting, retrying and stalled/stopped states; provider/task errors are stripped before serialisation. The deterministic scorer compiles role vocabulary once per projection, caches source tokenisation, and uses a stable sort when no coverage reranking is required.

The initial Auto snapshot precedes rubric creation. It therefore uses the advert and contextual aliases; ranked structured requirements apply when an explicitly refreshed snapshot has a saved effective rubric. The worker never fetches newer Career data after pinning an input. This limitation is intentional and is not described as full semantic retrieval.

Validation: database activity/career/conflict integration tests (28), core editing contracts (11), worker stages (10), web activity/auth/polling/render tests (12), server-action authorisation and editing integration tests (269), retrieval unit cases (5), workspace typechecks and production compilation passed. The production-browser CV modes check passed, including navigation away during a build, completion in Applications, mobile width, durable dismissal, cached Auto reuse, free Refine/Manual saves and finalisation. The worker database suite exercised 101 cases; three initially exposed a legacy retry regression and passed on targeted rerun after correction. The publication test verifies that the manifest survives checkpoint cleanup. Final regression details are recorded in the PR.

The account-wide client subscriber has a small initial JavaScript cost: the affected authenticated route budgets explicitly allow an additional 2 KB gzip. Shared root/public route caps and large-chunk limits remain unchanged. No measured whole-build latency or token reduction is claimed from this increment without live comparison.

Production migration/deployment and paid live-AI qualification have not been run. Neural embeddings, adaptive question ranking and external/closed-browser push are not implemented by this change.
