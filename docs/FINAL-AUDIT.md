# Functional audit — 7 September 2026

This is a source review and local regression audit, not a claim that every external website or production configuration has been verified.

## Fixed

- Migration advisory locks now use one dedicated PostgreSQL connection for acquisition, migrations and release. Previously a pool could run those operations on different sessions, bypassing mutual exclusion or leaving a lock behind. A concurrent-migration regression checks completion and released locks.
- Description updates now reevaluate only the affected role and queue scoring only for an eligible open role. Previously each detail fetch revisited the entire jobs table and then queued scoring even when cleanup deleted the role. An updated description invalidates the old fit score.
- Global filter reconciliation includes older closed roles. Previously it excluded them from evaluation but still subjected their stale filter flags to global deletion.
- Saving or undoing a decision now commits its learning tasks in the same transaction. A task insertion failure rolls the decision back. Undo requests a fresh profile rather than waiting for a new-decision threshold.
- Web and worker task insertion share one implementation through a narrow package export. The helper accepts transactions directly, removing duplicated defaults and an unnecessary transaction cast in CV requests.

## Reviewed behaviour

- Skipping requires a non-whitespace reason; bulk skips use the same validation. Reasons and role snapshots are retained. Filter changes remain proposals requiring acceptance, rather than silently rewriting preferences.
- Cleanup preserves roles with decisions, saved CVs or explicit archives. CV and application history therefore survives changing filters.
- CV requests snapshot both evidence and the description. Missing descriptions require pasted source text. Editing produces a new revision; reusable wording is appended to a versioned evidence library with a size limit.
- Applications retain PDF bytes at recording time and subsequent downloads return those stored bytes. The app records a user-reported submission; it does not submit an application or verify which file was sent externally.
- Partial scans guard against falsely closing absent roles. Full feed processing remains necessary where the provider offers no server-side filters.

## Outstanding gaps and limits

1. **Description-dependent filters on sparse feeds:** a new posting without a feed description can be discarded before its detail fetch. Add a bounded, resumable detail-fetch stage before admission, retaining lightweight queue references rather than non-matching job records. Include/exclude terms must both be evaluated against the fetched text. This is not an issue for Anduril's description-rich Greenhouse feed, but limits generic-board support.
2. **Serverless fallback duration:** the cron endpoint stops claiming at its budget but cannot guarantee a single external fetch or AI task finishes within Vercel's request limit. Keep long-running work on the Render worker; make the cron scheduler-only when an active worker is present, with a separately tested fallback policy.
3. **Legacy near-miss controls:** these are inconsistent with discard-before-storage. Retire the UI/settings as a coordinated migration rather than leaving an empty panel that suggests non-matches are still scored.
4. **Live verification:** this audit does not verify the deployed commit, live Anthropic generation, production library contents, deployment region latency or authenticated browser flows. Local tests use fixtures and a separate PostgreSQL database.
5. **Scale:** global gate changes still perform per-role updates. The earlier performance review's SQL pagination and batched-update opportunities remain relevant as retained history grows.

## Validation

Full type checking and automated suites cover core filtering, adapters, worker/queue behaviour, CV materialisation and web actions. New database regressions cover concurrent migrations, targeted gate refreshes and old closed-role cleanup. Build and route smoke results are reported with the accompanying change.
