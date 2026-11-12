# ADR implementation and precedence

Reviewed against main `6893adbd`, 12 November 2026. Use
[production readiness](../PRODUCTION-READINESS.md) for current rollout gates.
Individual ADR verification paragraphs describe their own historical checkpoints;
"pending" there is not a new feature backlog, and "verified" is not certification
of a later release.

| ADR | Accepted scope implemented | Interpretation / outstanding rollout |
| --- | --- | --- |
| [0001](0001-targeted-evidence-cv.md) | Targeted, evidence-backed drafting, imports and presentation | Later ADRs supersede strict editorial gates and editing behaviour |
| [0002](0002-ranked-cv-requirements.md) | Editable ordered requirements and essentials | Validate persistence and role-specific relevance on final model |
| [0003](0003-cv-skill-order-and-finalisation-choice.md) | Skills ordering and user override of editorial findings | Editorial warnings do not prevent finalisation; ownership/security invariants still apply |
| [0004](0004-measured-cv-capacity.md) | Font-aware measured page capacity | Verify final PDF fonts/layout and quality, not only text length |
| [0005](0005-cv-editing-modes.md) | Auto, persistent Refine and final-copy Manual; exact edits without full regeneration | Later career-record and entitlement decisions apply; validate dirty-buffer recovery |
| [0006](0006-linkedin-identity-import-and-network.md) | Optional LinkedIn OIDC, explicit linking, exported-profile onboarding | Developer app/product/credentials and hosted round trips required; sign-in does not import a full career history |
| [0007](0007-career-record-and-private-recommendations.md) | Career CMS, tags, parallel projects, enrichment, private recommendations, persistent conflict decisions | Review can be deferred without blocking CVs; paid promotion is deliberately deferred |
| [0008](0008-role-entitlements-and-contextual-editing.md) | One credit per role, tier editing allowances, inline AI and simplified UI | Stripe catalogue/setup, live ledger checks and comprehension testing required |
| [0009](0009-cv-execution-retrieval-and-activity.md) | Execution manifest/journal, bounded retrieval, durable app-wide activity | Migration 0076, hosted verification and live qualification required; embeddings/adaptive elicitation/external push deferred |

Later accepted decisions take precedence on overlapping behaviour. In particular,
do not reinstate mandatory proof approval from ADR 0001, charge for every exact
edit using pre-0008 wording, or interpret API sign-in as permission to scrape a
LinkedIn profile. No new implementation gap was established in the focused
manifest/retrieval/activity audit; production readiness remains conditional on
the current checklist and candidate-specific evidence.
