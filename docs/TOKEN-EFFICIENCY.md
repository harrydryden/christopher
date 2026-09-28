# Token efficiency audit

Audited 2026-09-28 against production `ai_calls` (read-only), the recorded build fixture
(`docs/evaluations/recordings/cv-replay-fixture.jsonl`, real request bodies), the prompt registry and
every call site. Prices: Fable 5.1 $10 in / $50 out / $0.25 cache read per MTok; Sonnet 5 $2 / $10.
Fable always thinks, and thinking is billed inside `output_tokens`, so output is the expensive side of
every CV call. The full per-stream working is in the session scratchpad; this is the decision document.

## 1. Where the tokens go

Thirty days, one active account, about $30:

| Call site | Share | Shape | Note |
|---|---|---|---|
| CV build (rubric, planning, author ×1–3, audit ×4–5 batches, improvement, re-audit) | 90 % | author 10–19k output tokens; an audit batch 6.7k; rubric 4.7k | $1.9 per audit pass, $0.8 per author call, $0.4 per rubric |
| A12 Library review | 6 % | 7.5k output a pass; one retry cost more than the pass it repaired | now scoped to changed rows and experience entries |
| A10 company suggestions | 3 % | 171k tokens of web-search context a run | 15 searches allowed |
| A5 fit scoring | 3 % | 3.3k context, 34 output per role | cheap per role, runs on every table change |
| A2, A7–A9 | <1 % | small, uncached | fine |

A calibrated tailored build on Fable is about $5.5: audit $2.2, re-audit $1.2, author $0.9 (+$0.6 a
rewrite), improvement $0.6, planning $0.5, rubric $0.25. The baseline audit and the re-audit are about
60 % of it; the optional improvement pair is about a third.

## 2. Integrity findings (fix regardless of tokens)

- **A four-day silent outage.** 235 calls between 5 and 9 September failed instantly with the
  provider's "API key is not scoped to a workspace" error. Nothing alerted. A2 recorded each failure as
  a page of kind `other`, and A5 marked 28 roles as scored with no score, so they are never queued
  again. Fix: a fail-fast breaker in the engine on a 4xx that names the key or model (stop the queue,
  surface on Health), A5 leaving such failures unscored for requeue, and a boot-time probe of the
  configured key and models. Model ids are checked only on save (`isKnownModel`), never on read, and
  `modelOverrides` never; one "claude-fable-5.1" typo reached the provider.
- **Enums never reach the output grammar.** The SDK (0.124) folds every `z.enum` into a description
  string, so statuses, claim verdicts, facets and the twenty-four evidence marks are unconstrained
  strings to the model. A wrong value fails the zod parse and costs the whole call again. Fix: restore
  `enum` when building `output_config.format` from the zod schema. One place, no quality risk.
- **The replay gate cannot vouch for a change to the auditor.** `gradeCvReplay` grades a candidate
  route with the audit that route produced, so a laxer audit grades itself; DEPLOY.md's first example
  (audit to medium) is exactly that. Author, planning and rubric changes are gated correctly. Fix: a
  fixed-judge replay that re-audits the candidate CV at the recorded route before grading.
- **Measurements missing.** `ai_calls` cannot separate thinking from visible output (add
  `output_chars`), does not keep the 1h/5m cache-write split, and does not count A10 pause
  continuations. There is no A5, A10, A11 or A12 eval harness. The fixture fits first time, so the
  fitter-rewrite and page-overflow paths are never exercised.
- **Not a problem, checked:** cache prefixes are byte-identical across the calls that share them and
  every block clears the minimum cacheable size; the "A5 cached nothing" count in production equals
  the failed calls exactly; the audit and the writer read the same confirmed, active evidence.

## 3. Gains, ranked

Savings are per build unless stated. "Gate" names how a quality regression would be caught.

### Tier 1 — no quality risk, small effort

| # | Change | Saving | Gate | Effort |
|---|---|---|---|---|
| 1 | **Gate the improvement pass** on the evidenced gap (weight or share) and page headroom, instead of any gap of weight ≥1. The fixture's pair cost 40 % of its build and was not adopted. | ~$1.75 on every skipped build | Adoption rate by gap weight from `cv_build_steps` (`compare_content` rows) picks the threshold; adopted revisions in the skipped bucket must be ≈0 | S |
| 2 | **Stop writing prose nobody reads.** Audit: `improvement` only when the match is not demonstrated; `reason` optional for supported claims. Planner: cap `reason`, cite `sourceId` without a quote. | $0.20–0.25 | Fields are unread in those cases (traced to the UI and worker); replay grade unchanged | S |
| 3 | **Writer provenance by id.** `bulletSources`/`summarySources` cite `sourceId` only; the quote is used by a substring check, is ~54 % of the author's visible JSON, and a misquote costs a whole extra author call. Drop the echoed previous plan on rewrites. | $0.20–0.37, plus fewer $0.6–0.8 rewrites | Row-level grounding stays (id must exist and the bullet is audited); watch factual-support grade in replay | S–M |
| 4 | **Scope corrective re-runs** to the flagged items (CV audit corrections, A12 uncovered entries) and merge by id instead of re-running the whole batch. | ~$0.30 per retry; the recorded A12 retry cost $0.53 | Same validators run on the merged result | M |
| 5 | **Writer cache TTL 1h → 5m** (and likely the audit's evidence block). Production shows 1.14 author calls a build and only ~10 % of consecutive CV calls more than five minutes apart; a 1h write costs 2× input, a 5m write 1.25×. | ~$0.13 net at the measured pattern | Cost only; replay `costUsd` shows it | S |
| 6 | **A5: skip skipped and archived roles** in `rescore_all`, whose score has no consumer, and send rescore passes (never new roles) through batch mode. | 50–70 % of A5 (≈$0.01 a role a pass) | Table order for undecided roles unchanged; membership never touched | S + M |
| 7 | **A11 import: derive `quote` from `text`** (both verbatim from the same row). **A4: return start and end anchors**, slice in code. **A12: number rows** and return the index rather than echo the row. | A11 30–45 % of output ($0.10–0.25 an import); A4 95 % of output; A12 ~$0.10 a batch | Validators already anchor `text`; the row-index design removes the "rewritten row" failure by construction | S–M |
| 8 | **A10: `max_uses` 15 → 6–8**, cache the transcript re-sent on a pause continuation, skip dormant accounts. | $0.20–0.25 a run (~45 %) | Suggestions are verified without a model afterwards; watch candidate yield per run | S |

### Tier 2 — needs the eval gate before shipping

| # | Change | Saving | Gate | Effort |
|---|---|---|---|---|
| 9 | **Author and planning at medium effort** via `stageRoutes`. | ~$0.26 (~8 %) | Existing replay gate (the high-effort audit judges); two or three paid recordings, then replace the guessed `EFFORT_OUTPUT_SCALE` with measured ratios | S + paid replay |
| 10 | **Fitter rewrites at medium effort** (attempts 2 and 3 are a mechanical refit). | $0.2–0.35 a rewrite | Page-fit loop bounds it; replay with a fixture that overflows (none exists yet) | S |
| 11 | **Audit at medium effort.** | ~$0.50 | Only after the fixed-judge replay (§2) exists | S after M |
| 12 | **Requirement verdict memo for the re-audit**: carry a demonstrated CV-side verdict whose cited quotes survive verbatim, like the claim memo. The library side is already fixed by the plan. | $0.55–0.70 | Status agreement ≥98 % and identical adoption decisions across recorded builds | M |
| 13 | **A12 on Sonnet 5** (rubric marks are a classification task). | $0.43 → $0.09 a ten-entry pass | Needs an A12 agreement harness first: mark and facet agreement against Fable on a fixed library, threshold ≥90 % | S + M harness |

### Not gains, with numbers

- Audit batch size 8 → 12/16: cached context is ~$0.004 a batch; merging saves ≤$0.2 against more
  latency and a larger failure blast radius.
- Trimming system prompts: they sit in cached prefixes; a 300-token cut saves ~$0.006 per hourly write.
  One dead sentence (the audit prompt's facet note) should go for clarity only.
- Ceilings (`maxTokens`) bill nothing. Running the first audit batch alone saves ~$0.65 an audit for a
  few seconds' wait: keep it. One cache shared across planning, writing and audit is impossible (the
  output schema sits in the cached prefix and differs).
- A3 extraction is already gated by recipe and content hash; monitor only.

## 4. What it adds up to

For a build that would have run an unadopted improvement, Tier 1 alone is roughly $2.5 of $5.5
(45 %). For a build that keeps its improvement, Tier 1 is about $0.8–1.0 (15–18 %); Tier 2 adds
$1.0–1.5 more once the eval gate can vouch for it. A5 falls by half to two thirds for an active
account; A10 by 45 % a run; A11 imports by a third.

## 5. Order of work

1. §2 integrity: breaker and Health surfacing, enum restoration, `output_chars` and cache-split
   columns, fixed-judge replay. These make every later measurement trustworthy.
2. Tier 1, items 1–5 (CV build), then 6–8. Each ships with its gate's before/after in the PR.
3. Record two or three live builds (docs/DEPLOY.md), then Tier 2 in the order listed.

## 6. Status

Shipped (September 2026):

- §2 breaker, settings validation on read, boot probe, A5 unscored on a model-access failure, and a
  Health row (spec: "Model access"). Enum and const restored to the output grammar.
- Tier 1, items 1–8, with these readings: the improvement gate uses the diagnostics and the write
  scale (`improvementWorthwhile`), since production holds no `cv_build_steps` rows to calibrate a
  threshold from; the audit's requirement `improvement` is empty when demonstrated and claim reasons
  are optional and capped, and the planner's reasons and quotes are stripped before the writer;
  writer provenance is id-only, checked by shared words; corrective re-runs carry only the flagged
  requirements and claims, and the A12 re-ask only the uncovered entries; writer and audit cache for
  five minutes; rescore passes skip skipped and archived views and run as background work the
  collector takes while scoring is live; A11 derives the quote, A4 returns anchors, A12 numbers rows;
  A10 allows eight searches, caches the paused turn on continuation, and skips dormant accounts.

Open: the fixed-judge replay and the `output_chars` and cache-split columns from §2; Tier 2, which
waits on those and on recorded live builds. A12's `expectedOutputTokens` (4,800) is not yet
re-measured after the row numbering.
