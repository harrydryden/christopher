# Workspace and pipeline rationalisation

Implemented September 2026:

- Main navigation: Roles, Companies, CVs, Applications and Settings. Companies owns discovery suggestions; Settings owns learning and health; CVs owns the evidence library and writing preferences. Existing URLs remain valid.
- Shortlist is the label for the existing `apply` decision. Persisted values remain compatible with learning history. Actual submitted applications remain a distinct, dated record with frozen PDF bytes.
- Role details contain description, events, source and CV creation. The main table drops its source column; controls and bulk actions use progressive disclosure.
- Role pages contain 50 visible rows. Lightweight metadata supports existing filter/sort behaviour; full descriptions and event histories are fetched only for current-page IDs, plus at most 50 preference-hidden rows. Filtering metadata remains in memory: this is not a claim of SQL-only filtering at unlimited scale. CSV export still covers all filtered records.
- Global gate updates and score enqueueing use batches of 250. Individual description refreshes remain scoped to their role.
- Listing retrieval is followed by a separate admission stage. When description keyword matching is configured and a listing lacks text, up to four detail requests run concurrently before persistence. Obvious title/department/seniority/location exclusions avoid detail work. Exclusions retain their existing title/department semantics. Unreadable descriptions mark the scan partial and defer admission to a later scan; they are not stored as non-matches. No model is required for this stage.
- Obsolete near-match controls, scoring budgets and settings definitions have been retired. Legacy stored settings are ignored and historical flags/data remain readable.
- Cron schedules work but does not execute long-running jobs by default. The Render worker consumes the queue. `CHRISTOPHER_SERVERLESS_FALLBACK=1` explicitly enables the legacy bounded fallback, only without a fresh worker heartbeat; its individual tasks can still exceed platform limits, so it is not the production recommendation.
- CV workspace presents the role → generation → edit/download sequence, evidence/preferences navigation, saved revisions and collapsed model configuration.

Deploy both web and worker code together. There is no schema migration. Existing URLs, decisions, evidence, CVs and submitted PDFs are retained. Live deployment and external AI calls are separate from local regression verification.
